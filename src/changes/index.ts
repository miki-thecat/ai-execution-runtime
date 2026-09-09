import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { kill, pid, platform } from "node:process";
import { hostname } from "node:os";
import type { OperationContext } from "../core/context.ts";
import {
  createChangesetId,
  createOperationMeta,
  createRuntimeError,
  runtimeFailure,
  runtimeSuccess,
  type ArtifactRef,
  type ChangesetId,
  type RuntimeResult,
} from "../core/index.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { StateStore } from "../state/store.ts";
import type { Tracer } from "../observability/tracer.ts";
import { sanitizeDurableText } from "../observability/redaction.ts";

export type ChangeSetStatus = "prepared" | "applied" | "rolled_back";

export interface ChangeSetFile {
  readonly path: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly beforeExists: boolean;
  readonly afterExists: boolean;
  readonly beforeSize: number;
  readonly afterSize: number;
  readonly beforeMode?: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly beforeArtifactRef?: ArtifactRef;
  readonly afterArtifactRef?: ArtifactRef;
  readonly diffSummary: string;
}

export interface ChangeSetDiffSummary {
  readonly filesChanged: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly paths: readonly string[];
}

export interface ChangeSet {
  readonly id: ChangesetId;
  readonly traceId: OperationContext["traceId"];
  readonly runId: OperationContext["runId"];
  readonly projectId?: OperationContext["projectId"];
  readonly actor: OperationContext["actor"];
  readonly status: ChangeSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly files: readonly ChangeSetFile[];
  readonly diffSummary: ChangeSetDiffSummary;
  readonly summary: string;
}

export interface ChangeSetInput {
  readonly context: OperationContext;
  readonly files: readonly ChangeSetFileInput[];
  readonly summary?: string;
}

export interface ChangeSetFileInput {
  readonly path: string;
  readonly before?: Uint8Array;
  readonly after: Uint8Array;
  readonly beforeExists?: boolean;
  readonly afterExists?: boolean;
  readonly beforeMode?: number;
}

export interface ChangeSetManagerOptions {
  readonly rootDir: string;
  readonly tracer?: Tracer;
  readonly artifacts?: ArtifactStore;
  readonly state?: StateStore;
  readonly clock?: () => Date;
}

export interface RollbackInput {
  readonly changeset: ChangeSet;
  readonly context: OperationContext;
}

interface Snapshot {
  readonly path: string;
  readonly before?: Uint8Array;
  readonly beforeExists: boolean;
}

interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
  readonly nonce: string;
  readonly processStartIdentity?: string;
}

/** Linux start time distinguishes a live owner from an unrelated reused PID. */
function processStartIdentity(processId: number): string | undefined {
  if (platform !== "linux") return undefined;
  try {
    const stat = new TextDecoder().decode(readFileSync(`/proc/${processId}/stat`));
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    return fields[19]; // Field 22; fields[0] is the process state (field 3).
  } catch {
    return undefined;
  }
}

export function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Resolve a semantic file path and reject lexical or symlink escapes. */
export function resolveConfinedPath(rootDir: string, filePath: string, allowMissing = false): string {
  if (filePath.trim() === "" || filePath.includes("\0")) {
    throw createRuntimeError({ code: "FILE_PATH_INVALID", message: "File path must be non-empty and contain no NUL byte", retryable: false, effect: "none" });
  }
  const root = realpathSync(resolve(rootDir));
  const candidate = resolve(root, filePath);
  assertInside(root, candidate);

  if (pathEntryExists(candidate)) {
    let physical: string;
    try {
      physical = realpathSync(candidate);
    } catch {
      throw createRuntimeError({ code: "FILE_PATH_ESCAPE", message: "Semantic file path resolves through an invalid symlink", retryable: false, effect: "none" });
    }
    assertInside(root, physical);
    return physical;
  }
  if (!allowMissing) {
    throw createRuntimeError({ code: "FILE_NOT_FOUND", message: `File does not exist: ${filePath}`, retryable: false, effect: "none" });
  }

  let ancestor = candidate;
  while (!pathEntryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw createRuntimeError({ code: "FILE_PATH_INVALID", message: `Cannot resolve parent directory for: ${filePath}`, retryable: false, effect: "none" });
    }
    ancestor = parent;
  }
  const physicalAncestor = realpathSync(ancestor);
  assertInside(root, physicalAncestor);
  const unresolved = relative(ancestor, candidate);
  const physicalCandidate = resolve(physicalAncestor, unresolved);
  assertInside(root, physicalCandidate);
  return physicalCandidate;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertInside(root: string, candidate: string): void {
  const rest = relative(root, candidate);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw createRuntimeError({ code: "FILE_PATH_ESCAPE", message: "Semantic file path escapes the project root", retryable: false, effect: "none", details: { root } });
  }
}

export interface ConfinedFileRead {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly mode?: number;
}

/** Open first, then validate the opened descriptor so symlink swaps cannot redirect bytes. */
export function readConfinedFile(rootDir: string, filePath: string, allowMissing = false): ConfinedFileRead {
  const root = realpathSync(resolve(rootDir));
  const candidate = resolve(root, filePath);
  assertInside(root, candidate);
  if (platform !== "linux") throw createRuntimeError({ code: "FILE_CONFINEMENT_UNSUPPORTED", message: "Race-resistant semantic file reads require Linux /proc descriptor validation", retryable: false, effect: "none" });
  let file: number;
  try {
    file = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
    if (allowMissing && code === "ENOENT") return { path: resolveConfinedPath(root, filePath, true) };
    if (code === "ELOOP") throw createRuntimeError({ code: "FILE_PATH_ESCAPE", message: "Semantic file path resolves through a symlink", retryable: false, effect: "none" });
    if (code === "ENOENT") throw createRuntimeError({ code: "FILE_NOT_FOUND", message: `File does not exist: ${filePath}`, retryable: false, effect: "none" });
    throw cause;
  }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) throw createRuntimeError({ code: "FILE_NOT_REGULAR", message: `Not a regular file: ${filePath}`, retryable: false, effect: "none" });
    const physical = realpathSync(`/proc/self/fd/${file}`);
    assertInside(root, physical);
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(file, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw createRuntimeError({ code: "FILE_READ_RACE", message: "File changed while it was being read", retryable: true, effect: "none" });
      offset += count;
    }
    if (fstatSync(file).size !== stat.size) throw createRuntimeError({ code: "FILE_READ_RACE", message: "File changed while it was being read", retryable: true, effect: "none" });
    return { path: physical, bytes, mode: stat.mode & 0o7777 };
  } finally {
    closeSync(file);
  }
}

function currentBytes(rootDir: string, path: string): Uint8Array | undefined {
  return readConfinedFile(rootDir, relative(rootDir, path), true).bytes;
}

function assertCurrent(rootDir: string, path: string, expectedHash: string | undefined, expectedExists: boolean): void {
  const current = currentBytes(rootDir, path);
  const actualHash = current === undefined ? undefined : sha256(current);
  if ((current !== undefined) !== expectedExists || actualHash !== expectedHash) {
    throw createRuntimeError({
      code: "FILE_HASH_MISMATCH",
      message: "The file changed while applying the guarded change",
      retryable: false,
      effect: "none",
      details: { path, expectedHash, actualHash },
    });
  }
}

function atomicReplace(rootDir: string, path: string, content: Uint8Array, expectedHash: string | undefined, expectedExists: boolean, replacementMode?: number, onReplaced?: () => void): void {
  if (platform !== "linux") throw createRuntimeError({ code: "FILE_CONFINEMENT_UNSUPPORTED", message: "Race-resistant semantic file mutation requires Linux /proc descriptor anchoring", retryable: false, effect: "none" });
  const current = readConfinedFile(rootDir, relative(rootDir, path), true);
  const actualHash = current.bytes === undefined ? undefined : sha256(current.bytes);
  if ((current.bytes !== undefined) !== expectedExists || actualHash !== expectedHash) {
    throw createRuntimeError({ code: "FILE_HASH_MISMATCH", message: "The file changed while applying the guarded change", retryable: false, effect: "none", details: { path, expectedHash, actualHash } });
  }
  const parent = dirname(path);
  const confinedParent = resolveConfinedPath(rootDir, relative(rootDir, parent) || ".", false);
  if (confinedParent !== parent) throw createRuntimeError({ code: "FILE_PATH_ESCAPE", message: "Semantic file path parent changed outside the project root", retryable: false, effect: "none" });
  const directoryFd = openSync(parent, "r");
  const anchoredParent = `/proc/self/fd/${directoryFd}`;
  const temporary = join(anchoredParent, `.aer-tmp-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const destination = join(anchoredParent, basename(path));
  try {
    if (realpathSync(anchoredParent) !== parent) throw createRuntimeError({ code: "FILE_PATH_ESCAPE", message: "Semantic file path parent changed outside the project root", retryable: false, effect: "none" });
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, replacementMode ?? current.mode ?? 0o600);
    renameSync(temporary, destination);
    onReplaced?.();
    const actual = currentBytes(rootDir, path);
    if (actual === undefined || sha256(actual) !== sha256(content)) {
      throw createRuntimeError({ code: "FILE_WRITE_RACE", message: "The file changed while applying the guarded change", retryable: false, effect: "unknown", details: { path } });
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(directoryFd);
  }
}

function lineStats(before: Uint8Array | undefined, after: Uint8Array): { added: number; removed: number; summary: string } {
  const lines = (content: Uint8Array | undefined): string[] => {
    if (content === undefined) return [];
    const text = new TextDecoder().decode(content);
    if (text === "") return [];
    const result = text.split("\n");
    if (text.endsWith("\n")) result.pop();
    return result;
  };
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const removed = oldLines.length - prefix - suffix;
  const added = newLines.length - prefix - suffix;
  return { added, removed, summary: `+${added}/-${removed} lines` };
}

function byteLength(content: unknown): number {
  return new TextEncoder().encode(typeof content === "string" ? content : JSON.stringify(content)).byteLength;
}

export class ChangeSetManager {
  readonly rootDir: string;
  private readonly tracer: Tracer | undefined;
  private readonly artifacts: ArtifactStore | undefined;
  private readonly state: StateStore | undefined;
  private readonly clock: () => Date;
  private readonly snapshots = new Map<ChangesetId, readonly Snapshot[]>();

  constructor(options: ChangeSetManagerOptions) {
    this.rootDir = realpathSync(resolve(options.rootDir));
    this.tracer = options.tracer;
    this.artifacts = options.artifacts;
    this.state = options.state;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Persist evidence before a physical file mutation takes place. */
  prepare(input: ChangeSetInput): ChangeSet {
    if (input.files.length === 0) throw new Error("A ChangeSet must contain at least one file");
    const now = this.clock().toISOString();
    const files: ChangeSetFile[] = [];
    const snapshots: Snapshot[] = [];
    for (const file of input.files) {
      const beforeExists = file.beforeExists ?? file.before !== undefined;
      const afterExists = file.afterExists ?? true;
      const stats = lineStats(file.beforeExists === false ? undefined : file.before, file.after);
      const beforeArtifact = beforeExists && file.before !== undefined
        ? this.artifacts?.put(file.before, { mediaType: "text/plain", origin: "changeset.before" })
        : undefined;
      const afterArtifact = afterExists
        ? this.artifacts?.put(file.after, { mediaType: "text/plain", origin: "changeset.after" })
        : undefined;
      if (beforeArtifact !== undefined) this.emitArtifact(beforeArtifact.ref, beforeArtifact.size, input.context, "changeset.before");
      if (afterArtifact !== undefined) this.emitArtifact(afterArtifact.ref, afterArtifact.size, input.context, "changeset.after");
      const beforeHash = beforeExists && file.before !== undefined ? sha256(file.before) : undefined;
      const afterHash = afterExists ? sha256(file.after) : undefined;
      const record: ChangeSetFile = {
        path: file.path,
        ...(beforeHash === undefined ? {} : { beforeHash }),
        ...(afterHash === undefined ? {} : { afterHash }),
        beforeExists,
        afterExists,
        beforeSize: beforeExists && file.before !== undefined ? file.before.byteLength : 0,
        afterSize: afterExists ? file.after.byteLength : 0,
        ...(file.beforeMode === undefined ? {} : { beforeMode: file.beforeMode }),
        addedLines: stats.added,
        removedLines: stats.removed,
        ...(beforeArtifact === undefined ? {} : { beforeArtifactRef: beforeArtifact.ref }),
        ...(afterArtifact === undefined ? {} : { afterArtifactRef: afterArtifact.ref }),
        diffSummary: stats.summary,
      };
      files.push(record);
      snapshots.push({ path: file.path, ...(file.before === undefined ? {} : { before: file.before.slice() }), beforeExists });
    }
    const id = createChangesetId();
    const diffSummary: ChangeSetDiffSummary = {
      filesChanged: files.length,
      addedLines: files.reduce((total, file) => total + file.addedLines, 0),
      removedLines: files.reduce((total, file) => total + file.removedLines, 0),
      paths: files.map((file) => file.path).sort(),
    };
    const changeset: ChangeSet = {
      id,
      traceId: input.context.traceId,
      runId: input.context.runId,
      ...(input.context.projectId === undefined ? {} : { projectId: input.context.projectId }),
      actor: input.context.actor,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
      files,
      diffSummary,
      summary: input.summary ?? `${files.length} file${files.length === 1 ? "" : "s"} changed (${diffSummary.addedLines} additions, ${diffSummary.removedLines} removals)`,
    };
    this.snapshots.set(id, snapshots);
    this.persist(changeset, snapshots);
    this.emit("changeset.created", changeset, input.context);
    return changeset;
  }

  markApplied(changeset: ChangeSet, context: OperationContext): ChangeSet {
    const applied: ChangeSet = { ...changeset, status: "applied", updatedAt: this.clock().toISOString() };
    this.persist(applied);
    this.emit("changeset.applied", applied, context);
    return applied;
  }

  record(input: ChangeSetInput): ChangeSet {
    return this.withMutationLock(() => this.markApplied(this.prepare(input), input.context));
  }

  /** Prepare durable evidence, perform the guarded mutation, then mark it applied. */
  apply(input: ChangeSetInput, mutation: (prepared: ChangeSet) => void): ChangeSet {
    return this.withMutationLock(() => {
      const prepared = this.prepare(input);
      mutation(prepared);
      return this.markApplied(prepared, input.context);
    });
  }

  /** Serialize AER-mediated mutations in this project root. */
  withMutationLock<T>(operation: () => T): T {
    const lockPath = join(this.rootDir, ".aer-mutation.lock");
    const nonce = Math.random().toString(36).slice(2);
    const identity = processStartIdentity(pid);
    const owner = JSON.stringify({ pid, hostname: hostname(), createdAt: this.clock().toISOString(), nonce, ...(identity === undefined ? {} : { processStartIdentity: identity }) } satisfies LockOwner);
    const claimPath = join(this.rootDir, `.aer-mutation-claim-${pid}-${nonce}`);
    let acquired = false;
    try {
      writeFileSync(claimPath, owner, { flag: "wx", mode: 0o600 });
      try {
        linkSync(claimPath, lockPath);
        acquired = true;
      } catch (cause) {
        const code = cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
        if (code !== "EEXIST") throw cause;
        if (!this.reconcileStaleLock(lockPath)) {
          throw createRuntimeError({ code: "FILE_MUTATION_LOCKED", message: "Another semantic file mutation owns the project lock", retryable: true, effect: "none" });
        }
        try { linkSync(claimPath, lockPath); acquired = true; }
        catch (retryCause) {
          const retryCode = retryCause !== null && typeof retryCause === "object" && "code" in retryCause ? String(retryCause.code) : "";
          if (retryCode === "EEXIST") throw createRuntimeError({ code: "FILE_MUTATION_LOCKED", message: "Another semantic file mutation won stale-lock recovery", retryable: true, effect: "none" });
          throw retryCause;
        }
      }
      return operation();
    } finally {
      try { unlinkSync(claimPath); } catch { /* The private claim may already be gone. */ }
      if (acquired) {
        try { if (new TextDecoder().decode(readFileSync(lockPath)) === owner) unlinkSync(lockPath); } catch { /* Never remove a replacement lock. */ }
      }
    }
  }

  rollback(input: RollbackInput): RuntimeResult<ChangeSet> {
    const { changeset, context } = input;
    let writeApplied = false;
    try {
      return this.withMutationLock(() => {
        const snapshots = this.snapshots.get(changeset.id);
        const planned = changeset.files.map((file, index) => ({ file, snapshot: snapshots?.[index] }));
        const beforeContent = planned.map(({ file, snapshot }) => ({ file, content: this.contentForRollback(changeset.id, file, snapshot) }));
        const currentStates = planned.map(({ file }) => {
          const path = resolveConfinedPath(this.rootDir, file.path, true);
          const current = currentBytes(this.rootDir, path);
          return { file, path, currentHash: current === undefined ? undefined : sha256(current) };
        });

        // Preflight every file while holding the mutation lock. A rollback only
        // proceeds when each path is still the applied after-image (or is already
        // at its before-image, which is a safe idempotent state).
        for (const { file, currentHash } of currentStates) {
          if (currentHash === file.beforeHash || (!file.beforeExists && currentHash === undefined)) continue;
          if (currentHash !== file.afterHash) {
            const error = createRuntimeError({
              code: "ROLLBACK_PRECONDITION_FAILED",
              message: `Cannot safely roll back ${file.path}; the file changed after the ChangeSet was applied`,
              retryable: false,
              effect: "none",
              details: { path: file.path, expectedHash: file.afterHash, actualHash: currentHash },
            });
            return runtimeFailure(error, this.rollbackMeta(context, "failed", 0, error.effect));
          }
        }

        for (const { file, path, currentHash } of currentStates) {
          if (currentHash === file.beforeHash || (!file.beforeExists && currentHash === undefined)) continue;
          const content = beforeContent.find((entry) => entry.file === file)?.content;
          if (file.beforeExists && content !== undefined) {
            atomicReplace(this.rootDir, path, content, file.afterHash, true, file.beforeMode, () => { writeApplied = true; });
          } else if (!file.beforeExists) {
            assertCurrent(this.rootDir, path, file.afterHash, true);
            unlinkSync(path);
            writeApplied = true;
            if (existsSync(path)) throw createRuntimeError({ code: "FILE_WRITE_RACE", message: `Could not remove ${file.path} safely`, retryable: false, effect: "unknown" });
          }
        }
        const rolledBack: ChangeSet = { ...changeset, status: "rolled_back", updatedAt: this.clock().toISOString() };
        this.persist(rolledBack);
        this.emit("changeset.rolled_back", rolledBack, context);
        return runtimeSuccess(rolledBack, this.rollbackMeta(context, "completed", changeset.files.length));
      });
    } catch (cause: unknown) {
      const original = cause && typeof cause === "object" && "code" in cause
        ? cause as ReturnType<typeof createRuntimeError>
        : createRuntimeError({ code: "ROLLBACK_FAILED", message: cause instanceof Error ? cause.message : "Rollback failed", retryable: false, effect: "unknown" });
      const error = writeApplied && original.effect === "none" ? createRuntimeError({ ...original, effect: "unknown" }) : original;
      return runtimeFailure(error, this.rollbackMeta(context, error.effect === "unknown" ? "unknown" : "failed", 0, error.effect));
    }
  }

  private contentForRollback(changesetId: ChangesetId, file: ChangeSetFile, snapshot: Snapshot | undefined): Uint8Array | undefined {
    if (!file.beforeExists) return undefined;
    let content: Uint8Array | undefined;
    if (snapshot?.before !== undefined) content = snapshot.before;
    else if (file.beforeArtifactRef !== undefined && this.artifacts !== undefined) {
      try {
        const metadata = this.artifacts.metadata(file.beforeArtifactRef);
        if (metadata === undefined) throw new Error("missing metadata");
        const chunks: Uint8Array[] = [];
        let offset = 0;
        while (offset < metadata.size) {
          const chunk = this.artifacts.read(file.beforeArtifactRef, { offset, length: Math.min(64 * 1024, metadata.size - offset) });
          if (chunk.byteLength === 0) break;
          chunks.push(chunk); offset += chunk.byteLength;
        }
        content = new Uint8Array(offset);
        let cursor = 0;
        for (const chunk of chunks) { content.set(chunk, cursor); cursor += chunk.byteLength; }
      } catch {
        throw createRuntimeError({ code: "ROLLBACK_EVIDENCE_INTEGRITY_FAILED", message: `Rollback evidence failed integrity verification for ${file.path}`, retryable: false, effect: "none" });
      }
    }
    const persisted = this.state?.getEntity("changeset_files", `${changesetId}:${file.path}`);
    const value = persisted?.data?.rollbackBeforeBytes;
    if (content === undefined && Array.isArray(value) && value.every((byte): byte is number => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      content = Uint8Array.from(value);
    }
    if (content !== undefined && file.beforeHash === sha256(content) && content.byteLength === file.beforeSize) return content;
    if (content !== undefined) throw createRuntimeError({ code: "ROLLBACK_EVIDENCE_INTEGRITY_FAILED", message: `Rollback evidence does not match the recorded before-image for ${file.path}`, retryable: false, effect: "none" });
    throw createRuntimeError({ code: "ROLLBACK_EVIDENCE_MISSING", message: `Rollback evidence is unavailable for ${file.path}`, retryable: false, effect: "none" });
  }

  private rollbackMeta(context: OperationContext, status: "completed" | "failed" | "unknown", filesChanged: number, effectState: "none" | "unknown" | "applied" = status === "completed" ? "applied" : "none") {
    return createOperationMeta({
      context,
      operation: "change.rollback",
      status,
      effectClass: "workspace_write",
      effectState,
      metrics: { internalCalls: 1, filesChanged },
      summary: status === "completed" ? "ChangeSet rolled back" : "ChangeSet rollback rejected",
      truncated: false,
    });
  }

  private persist(changeset: ChangeSet, snapshots: readonly Snapshot[] | undefined = undefined): void {
    if (this.state === undefined) return;
    this.state.saveEntity({
      kind: "changesets",
      id: changeset.id,
      ...(changeset.projectId === undefined ? {} : { projectId: changeset.projectId }),
      runId: changeset.runId,
      status: changeset.status,
      traceId: changeset.traceId,
      createdAt: changeset.createdAt,
      updatedAt: changeset.updatedAt,
      data: { changesetId: changeset.id, summary: sanitizeDurableText(changeset.summary), diffSummary: changeset.diffSummary, files: changeset.files },
    });
    for (const [index, file] of changeset.files.entries()) {
      const previous = this.state.getEntity("changeset_files", `${changeset.id}:${file.path}`);
      const snapshot = snapshots?.[index];
      const rollbackBeforeBytes = snapshot?.before !== undefined && file.beforeArtifactRef === undefined
        ? [...snapshot.before]
        : previous?.data?.rollbackBeforeBytes;
      this.state.saveEntity({
        kind: "changeset_files",
        id: `${changeset.id}:${file.path}`,
        changesetId: changeset.id,
        ...(changeset.projectId === undefined ? {} : { projectId: changeset.projectId }),
        runId: changeset.runId,
        status: changeset.status,
        traceId: changeset.traceId,
        data: { ...file, ...(rollbackBeforeBytes === undefined ? {} : { rollbackBeforeBytes }) },
      });
    }
  }

  private reconcileStaleLock(lockPath: string): boolean {
    try {
      const before = lstatSync(lockPath);
      const raw = new TextDecoder().decode(readFileSync(lockPath));
      let stale = false;
      try {
        const parsed = JSON.parse(raw) as Partial<LockOwner>;
        if (parsed.hostname !== hostname() || typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.nonce !== "string") return false;
        let live = true;
        try { kill(parsed.pid, 0); }
        catch (cause) {
          const code = cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
          if (code === "ESRCH") live = false;
          else return false;
        }
        stale = !live;
        if (live && typeof parsed.processStartIdentity === "string") {
          const currentIdentity = processStartIdentity(parsed.pid);
          stale = currentIdentity !== undefined && currentIdentity !== parsed.processStartIdentity;
        }
      } catch {
        // Current locks are installed by hard-linking a fully written claim, so
        // malformed/empty or foreign-host locks cannot be deleted safely.
        return false;
      }
      if (!stale) return false;
      const after = lstatSync(lockPath);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return false;
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  private emitArtifact(ref: ArtifactRef, size: number, context: OperationContext, origin: string): void {
    this.tracer?.emit({
      traceId: context.traceId,
      runId: context.runId,
      spanId: context.spanId ?? ("span_uninstrumented" as import("../core/index.ts").SpanId),
      ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }),
      type: "artifact.created",
      actor: context.actor,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      artifactRefs: [ref],
      measurements: { artifactBytes: size },
      metadata: { origin },
    });
  }

  private emit(type: "changeset.created" | "changeset.applied" | "changeset.rolled_back", changeset: ChangeSet, context: OperationContext): void {
    this.tracer?.emit({
      traceId: context.traceId,
      runId: context.runId,
      spanId: context.spanId ?? ("span_uninstrumented" as import("../core/index.ts").SpanId),
      ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }),
      type,
      actor: context.actor,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      operation: type === "changeset.rolled_back" ? "change.rollback" : "file.patch",
      changesetId: changeset.id,
      status: "completed",
      effectClass: "workspace_write",
      effectState: type === "changeset.created" ? "none" : "applied",
      measurements: { filesChanged: changeset.files.length, internalCalls: 1 },
      summary: changeset.summary,
      metadata: { paths: changeset.diffSummary.paths, diffSummary: changeset.diffSummary },
    });
  }
}
