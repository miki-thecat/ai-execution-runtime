import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, closeSync, type Dirent } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DirectExecutor, resolveInside } from './direct.ts';
import { InMemoryMetrics } from './metrics.ts';
import { SqliteStore } from './store.ts';
import type {
  ArtifactRef,
  CommandOutput,
  CommandSpec,
  EventKind,
  EventStatus,
  GitState,
  JsonValue,
  MetricsHooks,
  ProjectState,
  RuntimeEvent,
  RuntimeResult,
  SearchMatch,
  Task,
  VerificationResult,
} from './types.ts';
import { error, failure, success } from './types.ts';

const execFileAsync = promisify(execFile);
const DEFAULT_READ_BYTES = 64 * 1024;
const DEFAULT_SEARCH_MATCHES = 100;
const DEFAULT_SEARCH_BYTES = 64 * 1024;

export interface RuntimeOptions {
  rootPath: string;
  databasePath?: string;
  metrics?: MetricsHooks;
}

export interface FileReadResult {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  artifactRef?: ArtifactRef;
}

export interface PatchResult {
  path: string;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  patchArtifact?: ArtifactRef;
}

export interface SearchOptions {
  cwd?: string;
  maxMatches?: number;
  maxBytes?: number;
  glob?: string;
}

interface EventStart {
  id: string;
  projectId: string;
  runId: string;
  kind: EventKind;
  name: string;
  startedAt: string;
  startedMs: number;
}

export class ExecutionRuntime {
  readonly rootPath: string;
  readonly projectId: string;
  readonly store: SqliteStore;
  readonly direct: DirectExecutor;
  readonly metrics: MetricsHooks;

  constructor(options: RuntimeOptions) {
    this.rootPath = resolve(options.rootPath);
    mkdirSync(this.rootPath, { recursive: true });
    const databasePath = options.databasePath ?? join(this.rootPath, '.runtime', 'runtime.db');
    this.store = new SqliteStore(databasePath);
    const project = this.store.upsertProject(this.rootPath);
    this.projectId = project.id;
    this.direct = new DirectExecutor(this.rootPath, this.projectId, this.store);
    this.metrics = options.metrics ?? new InMemoryMetrics();
  }

  close(): void {
    this.store.close();
  }

  project(): { id: string; rootPath: string } {
    return { id: this.projectId, rootPath: this.rootPath };
  }

  createTask(name: string): Task {
    return this.store.addTask(this.projectId, name);
  }

  addDecision(summary: string): void {
    this.store.addDecision(this.projectId, summary);
  }

  async inspect(): Promise<RuntimeResult<ProjectState>> {
    return this.projectState('project.inspect');
  }

  async resume(): Promise<RuntimeResult<ProjectState>> {
    return this.projectState('project.resume');
  }

  async shellRun(command: string, options: Omit<CommandSpec, 'command' | 'args'> = {}): Promise<RuntimeResult<CommandOutput>> {
    const event = this.startEvent('tool', 'shell.run');
    const result = await this.direct.shellRun(command, options);
    return this.finishCommand(event, result, { command: redact(command) });
  }

  processStart(command: string, options: Omit<CommandSpec, 'command' | 'args'> = {}): RuntimeResult<{ processId: string; command: string; startedAt: string }> {
    const event = this.startEvent('process', 'process.start');
    const result = this.direct.start({ ...options, command }, true);
    const status: EventStatus = result.ok ? 'succeeded' : 'failed';
    this.finishEvent(event, status, redact(command), {}, 0);
    this.metrics.recordToolCall({ durationMs: result.meta?.durationMs ?? 0, success: result.ok, outputBytes: 0 });
    return this.withEvents(result, [event.id]);
  }

  async processWait(processId: string): Promise<RuntimeResult<CommandOutput>> {
    const event = this.startEvent('process', 'process.wait');
    const result = await this.direct.wait(processId);
    return this.finishCommand(event, result, { processId }, true);
  }

  processCancel(processId: string): RuntimeResult<{ processId: string; cancelled: boolean }> {
    const event = this.startEvent('process', 'process.cancel');
    const result = this.direct.cancel(processId);
    const status: EventStatus = result.ok ? 'succeeded' : 'failed';
    this.finishEvent(event, status, `process ${processId}`, {}, 0);
    this.metrics.recordToolCall({ durationMs: 0, success: result.ok, outputBytes: 0 });
    return this.withEvents(result, [event.id]);
  }

  fileRead(requestedPath: string, maxBytes = DEFAULT_READ_BYTES): RuntimeResult<FileReadResult> {
    const event = this.startEvent('tool', 'file.read');
    try {
      const filePath = resolveInside(this.rootPath, requestedPath);
      const stats = statSync(filePath);
      if (!stats.isFile()) throw new Error(`Not a file: ${requestedPath}`);
      const boundedSize = Math.min(stats.size, Math.max(0, maxBytes));
      const buffer = Buffer.alloc(boundedSize);
      const fd = openSync(filePath, 'r');
      try {
        readSync(fd, buffer, 0, boundedSize, 0);
      } finally {
        closeSync(fd);
      }
      const result: FileReadResult = {
        path: relative(this.rootPath, filePath),
        content: buffer.toString('utf8'),
        sizeBytes: stats.size,
        truncated: stats.size > boundedSize,
      };
      if (result.truncated) result.artifactRef = this.persistArtifact('file', filePath, 'text/plain');
      const finished = this.finishEvent(event, 'succeeded', result.path, { truncated: result.truncated }, buffer.byteLength);
      this.metrics.recordToolCall({ durationMs: finished.durationMs ?? 0, success: true, outputBytes: buffer.byteLength });
      return success(result, { durationMs: finished.durationMs, eventIds: [event.id], ...(result.artifactRef === undefined ? {} : { artifactRefs: [result.artifactRef] }) });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const finished = this.finishEvent(event, 'failed', redact(requestedPath), { error: message }, 0);
      this.metrics.recordToolCall({ durationMs: finished.durationMs ?? 0, success: false, outputBytes: 0 });
      return failure(error(message.startsWith('Path escapes') ? 'PERMISSION_DENIED' : 'NOT_FOUND', message), { eventIds: [event.id] });
    }
  }

  filePatch(patch: string): RuntimeResult<PatchResult> {
    const event = this.startEvent('tool', 'file.patch');
    try {
      if (Buffer.byteLength(patch, 'utf8') > 256 * 1024) throw new Error('Patch exceeds 256 KiB bound');
      const parsed = parseUnifiedPatch(patch);
      const filePath = resolveInside(this.rootPath, parsed.path);
      const original = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
      const updated = applyUnifiedPatch(original, parsed.hunks);
      writeFileSync(filePath, updated, 'utf8');
      const patchArtifact = this.persistTextArtifact('patch', patch, 'text/x-diff');
      const result = { path: relative(this.rootPath, filePath), changed: original !== updated, addedLines: parsed.addedLines, removedLines: parsed.removedLines, patchArtifact };
      const finished = this.finishEvent(event, 'succeeded', result.path, { addedLines: result.addedLines, removedLines: result.removedLines }, Buffer.byteLength(patch));
      this.metrics.recordToolCall({ durationMs: finished.durationMs ?? 0, success: true, outputBytes: Buffer.byteLength(patch) });
      return success(result, { durationMs: finished.durationMs, eventIds: [event.id], artifactRefs: [patchArtifact] });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const finished = this.finishEvent(event, 'failed', 'patch rejected', { error: message }, Buffer.byteLength(patch));
      this.metrics.recordToolCall({ durationMs: finished.durationMs ?? 0, success: false, outputBytes: Buffer.byteLength(patch) });
      return failure(error(message.startsWith('Path escapes') ? 'PERMISSION_DENIED' : 'INVALID_ARGUMENT', message), { eventIds: [event.id] });
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<RuntimeResult<SearchMatch[]>> {
    const event = this.startEvent('tool', 'search');
    const started = Date.now();
    try {
      const cwd = resolveInside(this.rootPath, options.cwd ?? '.');
      const maxMatches = options.maxMatches ?? DEFAULT_SEARCH_MATCHES;
      const maxBytes = options.maxBytes ?? DEFAULT_SEARCH_BYTES;
      const rgMatches = await this.searchWithRg(query, cwd, maxMatches, maxBytes, options.glob);
      const matches = rgMatches ?? searchFallback(query, cwd, maxMatches, maxBytes, options.glob);
      const durationMs = Date.now() - started;
      this.finishEvent(event, 'succeeded', `search ${redact(query)}`, { matchCount: matches.length, engine: rgMatches === undefined ? 'fallback' : 'rg' }, matches.reduce((total, match) => total + Buffer.byteLength(match.text), 0));
      this.metrics.recordToolCall({ durationMs, success: true, outputBytes: matches.reduce((total, match) => total + Buffer.byteLength(match.text), 0) });
      return success(matches, { durationMs, eventIds: [event.id] });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.finishEvent(event, 'failed', 'search failed', { error: message }, 0);
      this.metrics.recordToolCall({ durationMs: Date.now() - started, success: false, outputBytes: 0 });
      return failure(error(message.startsWith('Path escapes') ? 'PERMISSION_DENIED' : 'INTERNAL', message), { eventIds: [event.id] });
    }
  }

  async verify(commands: Array<CommandSpec & { name?: string }>): Promise<RuntimeResult<VerificationResult>> {
    const event = this.startEvent('verification', 'verify');
    const started = Date.now();
    const outputs: Array<CommandOutput & { name?: string }> = [];
    let passed = true;
    for (const command of commands) {
      try {
        const output = await this.direct.executeDetailed(command, false);
        outputs.push(command.name === undefined ? output : { ...output, name: command.name });
        if (output.exitCode !== 0) passed = false;
      } catch {
        passed = false;
      }
    }
    const durationMs = Date.now() - started;
    const bytesOut = outputs.reduce((total, output) => total + Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr), 0);
    const status: EventStatus = passed ? 'succeeded' : 'failed';
    this.finishEvent(event, status, `${commands.length} verification command(s)`, { passed, commandCount: commands.length }, bytesOut);
    this.metrics.recordToolCall({ durationMs, success: passed, outputBytes: bytesOut });
    const value = { passed, commands: outputs, durationMs };
    return passed
      ? success(value, { durationMs, eventIds: [event.id] })
      : failure(error('COMMAND_FAILED', 'Verification failed', false, { commandCount: commands.length }), { durationMs, eventIds: [event.id] });
  }

  private async projectState(name: 'project.inspect' | 'project.resume'): Promise<RuntimeResult<ProjectState>> {
    const event = this.startEvent('project', name);
    const git = await this.gitState();
    this.finishEvent(event, git.available ? 'succeeded' : 'failed', name, { gitAvailable: git.available, clean: git.clean ?? false }, 0);
    const project = this.store.getProject(this.projectId);
    if (project === undefined) return failure(error('INTERNAL', 'Project record disappeared'), { eventIds: [event.id] });
    const state: ProjectState = {
      project,
      git,
      recentTasks: this.store.recentTasks(this.projectId),
      recentEvents: this.store.recentEvents(this.projectId),
      recentDecisions: this.store.recentDecisions(this.projectId),
      recentArtifacts: this.store.recentArtifacts(this.projectId),
    };
    this.metrics.recordToolCall({ durationMs: 0, success: git.available, outputBytes: 0 });
    return success(state, { eventIds: [event.id] });
  }

  private async gitState(): Promise<GitState> {
    try {
      const result = await execFileAsync('git', ['status', '--short', '--branch'], { cwd: this.rootPath, timeout: 3_000, maxBuffer: 64 * 1024 });
      const lines = result.stdout.trimEnd().split('\n').filter((line) => line.length > 0);
      const branchLine = lines.shift() ?? '';
      const branch = branchLine.startsWith('## ') ? branchLine.slice(3).split('...')[0] : undefined;
      const status = lines;
      return { available: true, ...(branch === undefined ? {} : { branch }), clean: status.length === 0, status };
    } catch (cause) {
      return { available: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  private async searchWithRg(query: string, cwd: string, maxMatches: number, maxBytes: number, glob?: string): Promise<SearchMatch[] | undefined> {
    return new Promise((resolveResult) => {
      const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(maxMatches), query, '.'];
      if (glob !== undefined) args.splice(args.length - 1, 0, '--glob', glob);
      let output = '';
      let available = true;
      const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(output) < maxBytes) output += Buffer.from(chunk).toString('utf8').slice(0, maxBytes - Buffer.byteLength(output));
      });
      child.once('error', () => {
        available = false;
      });
      child.once('close', () => {
        if (!available) return resolveResult(undefined);
        const matches: SearchMatch[] = [];
        for (const line of output.split('\n')) {
          const match = /^(.*?):(\d+):(.*)$/.exec(line);
          if (match === null) continue;
          matches.push({ path: match[1] ?? '', line: Number(match[2]), text: match[3] ?? '' });
          if (matches.length >= maxMatches) break;
        }
        resolveResult(matches);
      });
    });
  }

  private persistArtifact(kind: ArtifactRef['kind'], filePath: string, mediaType: string): ArtifactRef {
    return this.persistBytesArtifact(kind, readFileSync(filePath), mediaType, basename(filePath));
  }

  private persistTextArtifact(kind: ArtifactRef['kind'], content: string, mediaType: string): ArtifactRef {
    return this.persistBytesArtifact(kind, Buffer.from(content), mediaType, `${kind}.diff`);
  }

  private persistBytesArtifact(kind: ArtifactRef['kind'], content: Buffer, mediaType: string, sourceName: string): ArtifactRef {
    const id = randomUUID();
    const artifactDirectory = join(this.rootPath, '.runtime', 'artifacts');
    mkdirSync(artifactDirectory, { recursive: true });
    const artifactPath = join(artifactDirectory, `${id}-${sourceName.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    writeFileSync(artifactPath, content);
    const artifact: ArtifactRef = {
      id,
      kind,
      path: relative(this.rootPath, artifactPath),
      mediaType,
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    this.store.addArtifact(this.projectId, artifact);
    return artifact;
  }

  private startEvent(kind: EventKind, name: string): EventStart {
    const event: RuntimeEvent = {
      id: randomUUID(),
      projectId: this.projectId,
      runId: randomUUID(),
      kind,
      name,
      status: 'started',
      startedAt: new Date().toISOString(),
      attempt: 1,
      retryCount: 0,
      bytesIn: 0,
      bytesOut: 0,
      summary: name,
      metadata: {},
    };
    this.store.appendEvent(event);
    return { id: event.id, projectId: this.projectId, runId: event.runId ?? randomUUID(), kind, name, startedAt: event.startedAt, startedMs: Date.now() };
  }

  private finishEvent(start: EventStart, status: EventStatus, summary: string, metadata: Record<string, JsonValue>, bytesOut: number): RuntimeEvent {
    const endedAt = new Date().toISOString();
    const event: RuntimeEvent = {
      id: randomUUID(),
      projectId: start.projectId,
      runId: start.runId,
      kind: start.kind,
      name: start.name,
      status,
      startedAt: start.startedAt,
      endedAt,
      durationMs: Math.max(0, Date.now() - start.startedMs),
      attempt: 1,
      retryCount: 0,
      bytesIn: 0,
      bytesOut,
      summary: redact(summary),
      metadata,
    };
    this.store.appendEvent(event);
    return event;
  }

  private finishCommand(event: EventStart, result: RuntimeResult<CommandOutput>, metadata: Record<string, JsonValue>, polling = false): RuntimeResult<CommandOutput> {
    const output = result.ok ? result.value : undefined;
    const bytesOut = output === undefined ? 0 : Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
    const status: EventStatus = result.ok ? 'succeeded' : result.error.code === 'CANCELLED' ? 'cancelled' : 'failed';
    const finished = this.finishEvent(event, status, event.name, {
      ...metadata,
      ...(output === undefined ? {} : {
        exitCode: output.exitCode,
        signal: output.signal,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
      }),
    }, bytesOut);
    this.metrics.recordToolCall({ durationMs: finished.durationMs ?? 0, success: result.ok, outputBytes: bytesOut, polling });
    return this.withEvents(result, [event.id, finished.id]);
  }

  private withEvents<T>(result: RuntimeResult<T>, eventIds: string[]): RuntimeResult<T> {
    return result.ok
      ? success(result.value, { ...(result.meta ?? {}), eventIds, ...(result.meta?.artifactRefs === undefined ? {} : { artifactRefs: result.meta.artifactRefs }) })
      : failure(result.error, { ...(result.meta ?? {}), eventIds, ...(result.meta?.artifactRefs === undefined ? {} : { artifactRefs: result.meta.artifactRefs }) });
  }
}

function redact(value: string): string {
  return value
    .replace(/((?:token|password|secret|api[_-]?key|authorization)\s*[=:]\s*)([^\s]+)/gi, '$1<redacted>')
    .slice(0, 240);
}

interface UnifiedPatch {
  path: string;
  hunks: string[][];
  addedLines: number;
  removedLines: number;
}

function parseUnifiedPatch(input: string): UnifiedPatch {
  const lines = input.replace(/\r/g, '').split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const plusIndex = lines.findIndex((line) => line.startsWith('+++ '));
  if (plusIndex < 1) throw new Error('Patch must contain --- and +++ file headers');
  const rawPath = (lines[plusIndex] ?? '').slice(4).split('\t')[0] ?? '';
  const path = rawPath.replace(/^b\//, '');
  if (path.length === 0 || path === '/dev/null') throw new Error('Patch target is required');
  const hunkIndexes = lines.map((line, index) => /^@@ /.test(line) ? index : -1).filter((index) => index >= 0);
  if (hunkIndexes.length === 0) throw new Error('Patch must contain at least one hunk');
  const hunks: string[][] = [];
  let addedLines = 0;
  let removedLines = 0;
  for (let index = 0; index < hunkIndexes.length; index += 1) {
    const start = hunkIndexes[index] ?? 0;
    const end = hunkIndexes[index + 1] ?? lines.length;
    const header = lines[start] ?? '';
    const body = lines.slice(start + 1, end).filter((line) => line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'));
    if (body.length === 0) throw new Error(`Empty hunk: ${header}`);
    hunks.push([header, ...body]);
    addedLines += body.filter((line) => line.startsWith('+')).length;
    removedLines += body.filter((line) => line.startsWith('-')).length;
  }
  return { path, hunks, addedLines, removedLines };
}

function applyUnifiedPatch(original: string, hunks: string[][]): string {
  const trailingNewline = original.endsWith('\n');
  const source = original.replace(/\r/g, '').split('\n');
  if (trailingNewline) source.pop();
  const output: string[] = [];
  let sourceIndex = 0;
  for (const hunk of hunks) {
    const header = hunk[0] ?? '';
    const location = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
    if (location === null) throw new Error(`Invalid hunk header: ${header}`);
    const hunkStart = Number(location[1]) - 1;
    while (sourceIndex < hunkStart) {
      const line = source[sourceIndex];
      if (line === undefined) throw new Error('Patch context is outside file');
      output.push(line);
      sourceIndex += 1;
    }
    for (const line of hunk.slice(1)) {
      const marker = line[0];
      const content = line.slice(1);
      if (marker === ' ') {
        if (source[sourceIndex] !== content) throw new Error(`Patch context mismatch at line ${sourceIndex + 1}`);
        output.push(content);
        sourceIndex += 1;
      } else if (marker === '-') {
        if (source[sourceIndex] !== content) throw new Error(`Patch removal mismatch at line ${sourceIndex + 1}`);
        sourceIndex += 1;
      } else if (marker === '+') {
        output.push(content);
      }
    }
  }
  while (sourceIndex < source.length) {
    const line = source[sourceIndex];
    if (line !== undefined) output.push(line);
    sourceIndex += 1;
  }
  return output.join('\n') + (trailingNewline ? '\n' : '');
}

function searchFallback(query: string, root: string, maxMatches: number, maxBytes: number, glob?: string): SearchMatch[] {
  const results: SearchMatch[] = [];
  let bytes = 0;
  const visit = (directory: string): void => {
    if (results.length >= maxMatches || bytes >= maxBytes) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxMatches || bytes >= maxBytes) return;
      if (entry.name === '.git' || entry.name === '.runtime' || entry.name === 'node_modules') continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || (glob !== undefined && !simpleGlobMatch(entry.name, glob))) continue;
      let content: string;
      try {
        if (statSync(fullPath).size > 2 * 1024 * 1024) continue;
        content = readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (results.length >= maxMatches || bytes >= maxBytes || !line.includes(query)) return;
        results.push({ path: relative(root, fullPath), line: index + 1, text: line });
        bytes += Buffer.byteLength(line);
      });
    }
  };
  visit(root);
  return results;
}

function simpleGlobMatch(name: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(name);
}
