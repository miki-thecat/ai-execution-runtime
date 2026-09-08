import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ArtifactRef, CommandOutput, CommandSpec, ProcessHandle, RuntimeResult } from './types.ts';
import { error, failure, success } from './types.ts';
import { SqliteStore } from './store.ts';

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const DEFAULT_ARTIFACT_THRESHOLD = 16 * 1024;

interface CapturedStream {
  value: string;
  totalBytes: number;
  truncated: boolean;
  artifactPath?: string;
}

interface ActiveProcess {
  handle: ProcessHandle;
  completion: Promise<CommandOutput>;
  resolveCompletion: (output: CommandOutput) => void;
  rejectCompletion: (reason: unknown) => void;
  spec: CommandSpec;
  shellCommand: boolean;
  stdoutCollector: OutputCollector;
  stderrCollector: OutputCollector;
}

export const resolveInside = (rootPath: string, requestedPath = '.'): string => {
  const root = resolve(rootPath);
  const target = resolve(root, requestedPath);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`Path escapes project root: ${requestedPath}`);
  }
  return target;
};

class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private readonly maxBytes: number;
  private readonly threshold: number;
  private totalBytes = 0;
  private truncated = false;
  private artifactPath: string | undefined;
  private readonly artifactDirectory: string;
  private readonly artifactName: string;

  constructor(artifactDirectory: string, artifactName: string, maxBytes: number, threshold: number) {
    this.artifactDirectory = artifactDirectory;
    this.artifactName = artifactName;
    this.maxBytes = Math.max(0, maxBytes);
    this.threshold = Math.min(this.maxBytes, Math.max(0, threshold));
  }

  add(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (this.artifactPath === undefined && this.totalBytes > this.threshold) {
      mkdirSync(this.artifactDirectory, { recursive: true });
      this.artifactPath = join(this.artifactDirectory, `${randomUUID()}-${this.artifactName}.log`);
      writeFileSync(this.artifactPath, Buffer.concat(this.chunks));
      this.chunks.length = 0;
    }
    if (this.artifactPath !== undefined) appendFileSync(this.artifactPath, chunk);
    if (this.chunks.reduce((sum, item) => sum + item.byteLength, 0) < this.maxBytes) {
      const remaining = this.maxBytes - this.chunks.reduce((sum, item) => sum + item.byteLength, 0);
      this.chunks.push(chunk.subarray(0, remaining));
    }
    if (this.totalBytes > this.maxBytes) this.truncated = true;
  }

  finish(): CapturedStream {
    return {
      value: Buffer.concat(this.chunks).toString('utf8'),
      totalBytes: this.totalBytes,
      truncated: this.truncated,
      ...(this.artifactPath === undefined ? {} : { artifactPath: this.artifactPath }),
    };
  }

  get path(): string | undefined {
    return this.artifactPath;
  }
}

export class DirectExecutor {
  private readonly processes = new Map<string, ActiveProcess>();
  private readonly projectRoot: string;
  private readonly projectId: string;
  private readonly store: SqliteStore;
  private readonly artifactDirectory: string;

  constructor(projectRoot: string, projectId: string, store: SqliteStore, artifactDirectory?: string) {
    this.projectRoot = projectRoot;
    this.projectId = projectId;
    this.store = store;
    this.artifactDirectory = artifactDirectory ?? join(projectRoot, '.runtime', 'artifacts');
    mkdirSync(this.artifactDirectory, { recursive: true });
  }

  async shellRun(command: string, options: Omit<CommandSpec, 'command' | 'args'> = {}): Promise<RuntimeResult<CommandOutput>> {
    return this.execute({ ...options, command }, true);
  }

  async execute(spec: CommandSpec, shellCommand = false): Promise<RuntimeResult<CommandOutput>> {
    try {
      const output = await this.executeDetailed(spec, shellCommand);
      if (output.exitCode !== 0) {
        return failure(error('COMMAND_FAILED', `Command exited with ${output.exitCode ?? output.signal ?? 'unknown'}`, false, {
          exitCode: output.exitCode,
          signal: output.signal,
        }), { durationMs: output.durationMs, artifactRefs: output.artifactRefs });
      }
      return success(output, { durationMs: output.durationMs, artifactRefs: output.artifactRefs });
    } catch (cause) {
      return failure(error('INTERNAL', cause instanceof Error ? cause.message : String(cause), false));
    }
  }

  async executeDetailed(spec: CommandSpec, shellCommand = false): Promise<CommandOutput> {
    const active = this.startInternal(spec, shellCommand);
    const output = await active.completion;
    const refs = this.persistArtifacts(output, active);
    this.processes.delete(active.handle.processId);
    return { ...output, artifactRefs: refs };
  }

  start(spec: CommandSpec, shellCommand = true): RuntimeResult<{ processId: string; command: string; startedAt: string }> {
    try {
      const active = this.startInternal(spec, shellCommand);
      return success({ processId: active.handle.processId, command: active.handle.command, startedAt: active.handle.startedAt });
    } catch (cause) {
      return failure(error('INTERNAL', cause instanceof Error ? cause.message : String(cause), false));
    }
  }

  async wait(processId: string): Promise<RuntimeResult<CommandOutput>> {
    const active = this.processes.get(processId);
    if (active === undefined) return failure(error('NOT_FOUND', `Process not found: ${processId}`));
    const output = await active.completion;
    const refs = this.persistArtifacts(output, active);
    const result = { ...output, artifactRefs: refs };
    this.processes.delete(processId);
    if (output.signal === 'SIGTERM') return failure(error('CANCELLED', 'Process was cancelled'), { durationMs: output.durationMs, artifactRefs: refs });
    if (output.exitCode !== 0) return failure(error('COMMAND_FAILED', `Command exited with ${output.exitCode ?? output.signal ?? 'unknown'}`), { durationMs: output.durationMs, artifactRefs: refs });
    return success(result, { durationMs: output.durationMs, artifactRefs: refs });
  }

  cancel(processId: string): RuntimeResult<{ processId: string; cancelled: boolean }> {
    const active = this.processes.get(processId);
    if (active === undefined) return failure(error('NOT_FOUND', `Process not found: ${processId}`));
    const cancelled = active.handle.child.kill('SIGTERM');
    return success({ processId, cancelled });
  }

  private startInternal(spec: CommandSpec, shellCommand: boolean): ActiveProcess {
    const cwd = resolveInside(this.projectRoot, spec.cwd ?? '.');
    const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const artifactThresholdBytes = spec.artifactThresholdBytes ?? DEFAULT_ARTIFACT_THRESHOLD;
    const processId = randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const stdoutCollector = new OutputCollector(this.artifactDirectory, `${processId}-stdout`, maxOutputBytes, artifactThresholdBytes);
    const stderrCollector = new OutputCollector(this.artifactDirectory, `${processId}-stderr`, maxOutputBytes, artifactThresholdBytes);
    const child = shellCommand
      ? spawn('/bin/sh', ['-c', spec.command], { cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(spec.command, spec.args ?? [], { cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const handle: ProcessHandle = { processId, command: shellCommand ? spec.command : [spec.command, ...(spec.args ?? [])].join(' '), startedAt, child };
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    let resolveCompletion!: (output: CommandOutput) => void;
    let rejectCompletion!: (reason: unknown) => void;
    const completion = new Promise<CommandOutput>((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    const active: ActiveProcess = {
      handle,
      completion,
      resolveCompletion,
      rejectCompletion,
      spec,
      shellCommand,
      stdoutCollector,
      stderrCollector,
    };
    this.processes.set(processId, active);
    child.stdout?.on('data', (chunk: Buffer) => stdoutCollector.add(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderrCollector.add(Buffer.from(chunk)));
    if (spec.timeoutMs !== undefined) {
      timeout = setTimeout(() => child.kill('SIGTERM'), spec.timeoutMs);
    }
    child.once('error', (cause) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      rejectCompletion(cause);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      const stdout = stdoutCollector.finish();
      const stderr = stderrCollector.finish();
      resolveCompletion({
        command: handle.command,
        exitCode,
        signal,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Math.round(performance.now() - started),
        artifactRefs: [],
      });
    });
    return active;
  }

  private persistArtifacts(output: CommandOutput, active: ActiveProcess): ArtifactRef[] {
    const refs: ArtifactRef[] = [];
    const outputPaths = [
      { path: active.stdoutCollector.path, kind: 'stdout' as const, mediaType: 'text/plain' },
      { path: active.stderrCollector.path, kind: 'stderr' as const, mediaType: 'text/plain' },
    ];
    for (const item of outputPaths) {
      if (item.path === undefined || !existsSync(item.path)) continue;
      const bytes = readFileSync(item.path);
      const artifact: ArtifactRef = {
        id: randomUUID(),
        kind: item.kind,
        path: relative(this.projectRoot, item.path),
        mediaType: item.mediaType,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      this.store.addArtifact(this.projectId, artifact);
      refs.push(artifact);
    }
    return refs;
  }
}
