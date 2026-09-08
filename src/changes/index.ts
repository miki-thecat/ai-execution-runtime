import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pid } from "node:process";
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

export type ChangeSetStatus = "applied" | "rolled_back";

export interface ChangeSetFile {
  readonly path: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly beforeExists: boolean;
  readonly afterExists: boolean;
  readonly beforeSize: number;
  readonly afterSize: number;
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

function atomicReplace(path: string, content: Uint8Array): void {
  const temporary = `${path}.aer-tmp-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
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

  record(input: ChangeSetInput): ChangeSet {
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
      status: "applied",
      createdAt: now,
      updatedAt: now,
      files,
      diffSummary,
      summary: input.summary ?? `${files.length} file${files.length === 1 ? "" : "s"} changed (${diffSummary.addedLines} additions, ${diffSummary.removedLines} removals)`,
    };
    this.snapshots.set(id, snapshots);
    this.persist(changeset);
    this.emit("changeset.created", changeset, input.context);
    this.emit("changeset.applied", changeset, input.context);
    return changeset;
  }

  rollback(input: RollbackInput): RuntimeResult<ChangeSet> {
    const { changeset, context } = input;
    try {
      const snapshots = this.snapshots.get(changeset.id);
      const planned = changeset.files.map((file, index) => ({ file, snapshot: snapshots?.[index] }));
      const beforeContent = planned.map(({ file, snapshot }) => ({ file, content: this.contentForRollback(file, snapshot) }));

      // Preflight every file before changing any of them. This keeps a multi-file
      // rollback from partially applying after one file was edited externally.
      for (const { file } of planned) {
        const path = resolveConfinedPath(this.rootDir, file.path, true);
        const current = existsSync(path) ? readFileSync(path) : undefined;
        const currentHash = current === undefined ? undefined : sha256(current);
        if (currentHash === file.beforeHash || (!file.beforeExists && current === undefined)) continue;
        if (currentHash !== file.afterHash) {
          return runtimeFailure(createRuntimeError({
            code: "ROLLBACK_PRECONDITION_FAILED",
            message: `Cannot safely roll back ${file.path}; the file changed after the ChangeSet was applied`,
            retryable: false,
            effect: "none",
            details: { path: file.path, expectedHash: file.afterHash, actualHash: currentHash },
          }), this.rollbackMeta(context, "failed", 0));
        }
      }

      for (const { file, content } of beforeContent) {
        const path = resolveConfinedPath(this.rootDir, file.path, true);
        if (file.beforeExists && content !== undefined) {
          mkdirSync(dirname(path), { recursive: true });
          atomicReplace(path, content);
        } else if (!file.beforeExists && existsSync(path)) {
          unlinkSync(path);
        }
      }
      const rolledBack: ChangeSet = { ...changeset, status: "rolled_back", updatedAt: this.clock().toISOString() };
      this.persist(rolledBack);
      this.emit("changeset.rolled_back", rolledBack, context);
      return runtimeSuccess(rolledBack, this.rollbackMeta(context, "completed", changeset.files.length));
    } catch (cause: unknown) {
      const error = cause && typeof cause === "object" && "code" in cause
        ? cause as ReturnType<typeof createRuntimeError>
        : createRuntimeError({ code: "ROLLBACK_FAILED", message: cause instanceof Error ? cause.message : "Rollback failed", retryable: false, effect: "unknown" });
      return runtimeFailure(error, this.rollbackMeta(context, "failed", 0));
    }
  }

  private contentForRollback(file: ChangeSetFile, snapshot: Snapshot | undefined): Uint8Array | undefined {
    if (!file.beforeExists) return undefined;
    if (snapshot?.before !== undefined) return snapshot.before;
    if (file.beforeArtifactRef !== undefined && this.artifacts !== undefined) return this.artifacts.read(file.beforeArtifactRef);
    throw createRuntimeError({ code: "ROLLBACK_EVIDENCE_MISSING", message: `Rollback evidence is unavailable for ${file.path}`, retryable: false, effect: "none" });
  }

  private rollbackMeta(context: OperationContext, status: "completed" | "failed", filesChanged: number) {
    return createOperationMeta({
      context,
      operation: "change.rollback",
      status,
      effectClass: "write",
      effectState: status === "completed" ? "applied" : "none",
      metrics: { internalCalls: 1, filesChanged },
      summary: status === "completed" ? "ChangeSet rolled back" : "ChangeSet rollback rejected",
      truncated: false,
    });
  }

  private persist(changeset: ChangeSet): void {
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
      data: { changesetId: changeset.id, summary: changeset.summary, diffSummary: changeset.diffSummary, files: changeset.files },
    });
    for (const file of changeset.files) {
      this.state.saveEntity({
        kind: "changeset_files",
        id: `${changeset.id}:${file.path}`,
        changesetId: changeset.id,
        ...(changeset.projectId === undefined ? {} : { projectId: changeset.projectId }),
        runId: changeset.runId,
        status: changeset.status,
        traceId: changeset.traceId,
        data: { ...file },
      });
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
      effectClass: "write",
      effectState: type === "changeset.rolled_back" ? "applied" : "applied",
      measurements: { filesChanged: changeset.files.length, internalCalls: 1 },
      summary: changeset.summary,
      metadata: { paths: changeset.diffSummary.paths, diffSummary: changeset.diffSummary },
    });
  }
}
