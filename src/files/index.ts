import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pid } from "node:process";
import {
  createOperationMeta,
  createRuntimeError,
  runtimeFailure,
  runtimeSuccess,
  type OperationContext,
  type RuntimeError,
  type RuntimeResult,
} from "../core/index.ts";
import { isEffectAllowed, requiresApproval } from "../core/effects.ts";
import type { ArtifactRef } from "../core/ids.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import {
  ChangeSetManager,
  resolveConfinedPath,
  sha256,
  type ChangeSet,
  type ChangeSetManagerOptions,
} from "../changes/index.ts";
import { Tracer, type OperationSpan } from "../observability/index.ts";
import type { Operation } from "../operations/operation.ts";

export const DEFAULT_MAX_FILE_READ_BYTES = 64 * 1024;
export const DEFAULT_MAX_SEARCH_RESULTS = 100;

export interface FileReadInput {
  readonly path: string;
  /** One-based inclusive line number. Defaults to the first line. */
  readonly startLine?: number;
  /** One-based inclusive line number. */
  readonly endLine?: number;
  readonly maxBytes?: number;
}

export interface FileReadResult {
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
  /** Alias retained for callers that name the identity hash explicitly. */
  readonly sha256: string;
  readonly totalSizeBytes: number;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly nextLine?: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly artifactRefs: readonly ArtifactRef[];
}

export interface FileSearchInput {
  readonly query: string;
  readonly path?: string;
  readonly regex?: boolean;
  readonly maxResults?: number;
  readonly maxBytes?: number;
}

export interface FileSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly text: string;
}

export interface FileSearchResult {
  readonly query: string;
  readonly matches: readonly FileSearchMatch[];
  readonly resultCount: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly backend: "rg" | "fallback";
  readonly artifactRefs: readonly ArtifactRef[];
}

export interface FilePatchInput {
  readonly path: string;
  /** SHA-256 of the current file. Required when patching an existing file. */
  readonly expectedHash?: string | null;
  /** Alias for expectedHash. */
  readonly baseHash?: string | null;
  /** Complete replacement content. */
  readonly content?: string | Uint8Array;
  /** A small unified diff for this one file. */
  readonly patch?: string;
}

export interface FilePatchResult {
  readonly path: string;
  readonly beforeHash?: string;
  readonly afterHash: string;
  readonly changeset: ChangeSet;
  /** Pascal-case alias for transport callers. */
  readonly changeSet: ChangeSet;
}

export interface FileOperationsOptions extends Omit<ChangeSetManagerOptions, "rootDir"> {
  readonly rootDir: string;
  readonly maxReadBytes?: number;
  readonly maxSearchResults?: number;
}

interface Instrumentation {
  readonly span?: OperationSpan;
  readonly startedAt: string;
  readonly context: OperationContext;
}

interface InternalOptions {
  readonly instrument?: boolean;
}

interface SearchComputation {
  readonly result: FileSearchResult;
  readonly rawOutputBytes: number;
}

function byteLength(value: string | Uint8Array): number {
  return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}

function boundedText(bytes: Uint8Array, maxBytes: number): { text: string; truncated: boolean } {
  if (bytes.byteLength <= maxBytes) return { text: new TextDecoder().decode(bytes), truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder().decode(bytes.slice(0, end)), truncated: true };
}

function validLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw createRuntimeError({ code: "FILE_LIMIT_INVALID", message: `${label} must be a positive integer`, retryable: false, effect: "none" });
  return result;
}

function inputBytes(input: unknown): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength;
}

function safeError(cause: unknown, fallbackCode: string, fallbackEffect: "none" | "unknown" | "applied" = "none"): RuntimeError {
  if (cause && typeof cause === "object" && "code" in cause && "message" in cause && "effect" in cause) return cause as RuntimeError;
  return createRuntimeError({ code: fallbackCode, message: cause instanceof Error ? cause.message : "File operation failed", retryable: false, effect: fallbackEffect });
}

function assertEffectAllowed(context: OperationContext, effectClass: "read" | "write"): void {
  if (!isEffectAllowed(context.effectPolicy, effectClass)) throw createRuntimeError({ code: "EFFECT_NOT_ALLOWED", message: `File ${effectClass} is not allowed by the effect policy`, retryable: false, effect: "none" });
  if (requiresApproval(context.effectPolicy, effectClass)) throw createRuntimeError({ code: "EFFECT_APPROVAL_REQUIRED", message: `File ${effectClass} requires approval`, retryable: false, effect: "none" });
}

function unifiedPatch(source: string, patch: string): string {
  const lines = source.split("\n");
  const patchLines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunkIndex = patchLines.findIndex((line) => line.startsWith("@@"));
  if (hunkIndex < 0) return patch;
  const header = patchLines[hunkIndex]!;
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (match === null) throw createRuntimeError({ code: "PATCH_INVALID", message: "Unified patch hunk header is invalid", retryable: false, effect: "none" });
  const oldStart = Number(match[1]);
  const oldCount = Number(match[2] ?? "1");
  let cursor = oldStart - 1;
  const replacement: string[] = [];
  let consumed = 0;
  for (const line of patchLines.slice(hunkIndex + 1)) {
    if (line.startsWith("\\ No newline")) continue;
    const marker = line[0];
    const value = line.slice(1);
    if (marker === " ") {
      if (lines[cursor] !== value) throw createRuntimeError({ code: "PATCH_CONTEXT_MISMATCH", message: "Unified patch context does not match the current file", retryable: false, effect: "none" });
      replacement.push(value); cursor += 1; consumed += 1;
    } else if (marker === "-") {
      if (lines[cursor] !== value) throw createRuntimeError({ code: "PATCH_CONTEXT_MISMATCH", message: "Unified patch removal does not match the current file", retryable: false, effect: "none" });
      cursor += 1; consumed += 1;
    } else if (marker === "+") {
      replacement.push(value);
    } else if (line !== "") {
      throw createRuntimeError({ code: "PATCH_INVALID", message: "Unified patch contains an unsupported line", retryable: false, effect: "none" });
    }
  }
  if (consumed !== oldCount) throw createRuntimeError({ code: "PATCH_INVALID", message: "Unified patch line count does not match its hunk header", retryable: false, effect: "none" });
  lines.splice(oldStart - 1, oldCount, ...replacement);
  return lines.join("\n");
}

function relativeFile(root: string, path: string): string {
  const value = relative(root, path);
  return value === "" ? basename(root) : value;
}

export class FileOperations {
  readonly rootDir: string;
  readonly changes: ChangeSetManager;
  readonly tracer: Tracer;
  private readonly artifacts: ArtifactStore | undefined;
  private readonly maxReadBytes: number;
  private readonly maxSearchResults: number;

  constructor(options: FileOperationsOptions) {
    this.rootDir = resolveConfinedPath(options.rootDir, ".", false);
    this.tracer = options.tracer ?? new Tracer();
    this.artifacts = options.artifacts;
    this.maxReadBytes = validLimit(options.maxReadBytes, DEFAULT_MAX_FILE_READ_BYTES, "maxReadBytes");
    this.maxSearchResults = validLimit(options.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS, "maxSearchResults");
    this.changes = new ChangeSetManager({ ...options, rootDir: this.rootDir, tracer: this.tracer });
  }

  read(input: FileReadInput, context: OperationContext, options: InternalOptions = {}): RuntimeResult<FileReadResult> {
    const instrumentation = this.start("file.read", "read", context, options.instrument !== false);
    const operationContext = instrumentation.context;
    try {
      assertEffectAllowed(operationContext, "read");
      const maxBytes = validLimit(input.maxBytes, this.maxReadBytes, "maxBytes");
      const path = resolveConfinedPath(this.rootDir, input.path);
      const stat = statSync(path);
      if (!stat.isFile()) throw createRuntimeError({ code: "FILE_NOT_REGULAR", message: `Not a regular file: ${input.path}`, retryable: false, effect: "none" });
      const bytes = readFileSync(path);
      const fullText = new TextDecoder().decode(bytes);
      const lines = fullText === "" ? [] : fullText.split("\n");
      if (fullText.endsWith("\n")) lines.pop();
      const startLine = input.startLine ?? 1;
      const endLine = input.endLine ?? Math.max(startLine, lines.length);
      if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine) throw createRuntimeError({ code: "FILE_RANGE_INVALID", message: "Line range must be one-based and ordered", retryable: false, effect: "none" });
      const selectedLines = lines.slice(startLine - 1, endLine);
      const selected = selectedLines.join("\n") + (fullText.endsWith("\n") && endLine >= lines.length && selectedLines.length > 0 ? "\n" : "");
      const selectedBytes = new TextEncoder().encode(selected);
      const bounded = boundedText(selectedBytes, maxBytes);
      // A byte bound may end in the middle of a line. In that case the next
      // continuation starts on the same line, not on the following line.
      const completeLines = bounded.truncated
        ? [...bounded.text].filter((character) => character === "\n").length
        : selectedLines.length;
      const nextLine = bounded.truncated || endLine < lines.length ? startLine + completeLines : undefined;
      const hasMore = nextLine !== undefined;
      const refs = bounded.truncated ? this.putArtifact(bytes, "file.read", operationContext) : [];
      const data: FileReadResult = {
        path: relativeFile(this.rootDir, path),
        content: bounded.text,
        contentHash: sha256(bytes),
        sha256: sha256(bytes),
        totalSizeBytes: bytes.byteLength,
        totalLines: lines.length,
        startLine,
        endLine: Math.min(endLine, lines.length),
        ...(nextLine === undefined ? {} : { nextLine }),
        hasMore,
        truncated: bounded.truncated,
        artifactRefs: refs,
      };
      const metrics = { internalCalls: 1, inputBytes: inputBytes(input), rawOutputBytes: bytes.byteLength, returnedOutputBytes: byteLength(data.content), artifactBytes: refs.length === 0 ? 0 : bytes.byteLength, filesRead: 1 };
      return runtimeSuccess(data, this.finish(instrumentation, operationContext, "file.read", "read", metrics, refs, "completed", bounded.truncated ? "bounded file read; full content is in an artifact" : "bounded file read"));
    } catch (cause: unknown) {
      return this.failure(instrumentation, operationContext, "file.read", "read", safeError(cause, "FILE_READ_FAILED"), inputBytes(input));
    }
  }

  readFile(input: FileReadInput, context: OperationContext): RuntimeResult<FileReadResult> { return this.read(input, context); }

  search(input: FileSearchInput, context: OperationContext, options: InternalOptions = {}): RuntimeResult<FileSearchResult> {
    const instrumentation = this.start("file.search", "read", context, options.instrument !== false);
    const operationContext = instrumentation.context;
    try {
      assertEffectAllowed(operationContext, "read");
      const maxResults = validLimit(input.maxResults, this.maxSearchResults, "maxResults");
      if (input.query === "") throw createRuntimeError({ code: "SEARCH_QUERY_INVALID", message: "Search query cannot be empty", retryable: false, effect: "none" });
      const searchRoot = input.path === undefined ? this.rootDir : resolveConfinedPath(this.rootDir, input.path);
      const rg = this.searchWithRg(input, searchRoot, maxResults);
      const computation = rg ?? this.searchFallback(input, searchRoot, maxResults);
      const result = computation.result;
      const boundedByBytes = boundSearchBytes(result, input.maxBytes);
      const refs = boundedByBytes.hasMore ? this.putArtifact(new TextEncoder().encode(JSON.stringify(result.matches)), "file.search", operationContext) : [];
      const boundedResult: FileSearchResult = { ...boundedByBytes, artifactRefs: refs };
      const returnedOutputBytes = byteLength(JSON.stringify(boundedResult));
      const rawOutputBytes = computation.rawOutputBytes;
      const filesRead = new Set(result.matches.map((match) => match.path)).size;
      return runtimeSuccess(boundedResult, this.finish(instrumentation, operationContext, "file.search", "read", { internalCalls: 1, inputBytes: inputBytes(input), rawOutputBytes, returnedOutputBytes, artifactBytes: refs.length === 0 ? 0 : rawOutputBytes, filesRead }, refs, "completed", boundedResult.hasMore ? "bounded search results" : "search completed"));
    } catch (cause: unknown) {
      return this.failure(instrumentation, operationContext, "file.search", "read", safeError(cause, "FILE_SEARCH_FAILED"), inputBytes(input));
    }
  }

  patch(input: FilePatchInput, context: OperationContext, options: InternalOptions = {}): RuntimeResult<FilePatchResult> {
    const instrumentation = this.start("file.patch", "write", context, options.instrument !== false);
    const operationContext = instrumentation.context;
    try {
      assertEffectAllowed(operationContext, "write");
      if ((input.content === undefined) === (input.patch === undefined)) throw createRuntimeError({ code: "PATCH_INPUT_INVALID", message: "Provide exactly one of content or patch", retryable: false, effect: "none" });
      const path = resolveConfinedPath(this.rootDir, input.path, true);
      const before = existsSync(path) ? readFileSync(path) : undefined;
      if (existsSync(path) && !lstatSync(path).isFile()) throw createRuntimeError({ code: "FILE_NOT_REGULAR", message: `Not a regular file: ${input.path}`, retryable: false, effect: "none" });
      const expectedHash = input.expectedHash ?? input.baseHash;
      if (before !== undefined) {
        const actualHash = sha256(before);
        if (expectedHash === undefined || expectedHash === null || expectedHash !== actualHash) throw createRuntimeError({ code: "FILE_HASH_MISMATCH", message: `Refusing to overwrite ${input.path}; expected hash does not match`, retryable: false, effect: "none", details: { path: input.path, expectedHash, actualHash } });
      } else if (expectedHash !== undefined && expectedHash !== null) {
        throw createRuntimeError({ code: "FILE_HASH_MISMATCH", message: `Refusing to create ${input.path}; expected existing hash is not valid`, retryable: false, effect: "none", details: { path: input.path } });
      }
      const source = before === undefined ? "" : new TextDecoder().decode(before);
      const replacement = input.content !== undefined ? input.content : unifiedPatch(source, input.patch!);
      const after = typeof replacement === "string" ? new TextEncoder().encode(replacement) : replacement;
      const outputPath = resolveConfinedPath(this.rootDir, input.path, true);
      const current = existsSync(outputPath) ? readFileSync(outputPath) : undefined;
      const currentHash = current === undefined ? undefined : sha256(current);
      const beforeHash = before === undefined ? undefined : sha256(before);
      if (currentHash !== beforeHash || (current === undefined) !== (before === undefined)) {
        throw createRuntimeError({ code: "FILE_HASH_MISMATCH", message: `Refusing to overwrite ${input.path}; the file changed while preparing the patch`, retryable: false, effect: "none", details: { path: input.path, expectedHash: beforeHash, actualHash: currentHash } });
      }
      const parent = dirname(outputPath);
      if (!existsSync(parent) || !statSync(parent).isDirectory()) throw createRuntimeError({ code: "FILE_PARENT_MISSING", message: `Parent directory does not exist: ${input.path}`, retryable: false, effect: "none" });
      atomicWrite(this.rootDir, outputPath, after);
      const afterHash = sha256(after);
      const changeset = this.changes.record({ context: operationContext, files: [{ path: relativeFile(this.rootDir, outputPath), ...(before === undefined ? {} : { before }), after }] });
      const data: FilePatchResult = { path: relativeFile(this.rootDir, outputPath), ...(before === undefined ? {} : { beforeHash: sha256(before) }), afterHash, changeset, changeSet: changeset };
      const refs = changeset.files.flatMap((file) => [file.beforeArtifactRef, file.afterArtifactRef].filter((ref): ref is ArtifactRef => ref !== undefined));
      return runtimeSuccess(data, this.finish(instrumentation, operationContext, "file.patch", "write", { internalCalls: 1, inputBytes: inputBytes(input), rawOutputBytes: byteLength(after), returnedOutputBytes: byteLength(JSON.stringify(data)), artifactBytes: refs.length === 0 ? 0 : (before?.byteLength ?? 0) + after.byteLength, filesChanged: 1 }, refs, "completed", changeset.summary, "applied"));
    } catch (cause: unknown) {
      return this.failure(instrumentation, operationContext, "file.patch", "write", safeError(cause, "FILE_PATCH_FAILED"), inputBytes(input));
    }
  }

  write(input: FilePatchInput, context: OperationContext): RuntimeResult<FilePatchResult> { return this.patch(input, context); }

  rollback(changeset: ChangeSet, context: OperationContext, options: InternalOptions = {}): RuntimeResult<ChangeSet> {
    const instrumentation = this.start("change.rollback", "write", context, options.instrument !== false);
    const operationContext = instrumentation.context;
    const result = isEffectAllowed(operationContext.effectPolicy, "write") && !requiresApproval(operationContext.effectPolicy, "write")
      ? this.changes.rollback({ changeset, context: operationContext })
      : runtimeFailure(createRuntimeError({ code: requiresApproval(operationContext.effectPolicy, "write") ? "EFFECT_APPROVAL_REQUIRED" : "EFFECT_NOT_ALLOWED", message: "File rollback is not allowed by the effect policy", retryable: false, effect: "none" }), this.finishMeta(operationContext, "change.rollback", "write", "failed", { internalCalls: 1 }, instrumentation, undefined, "none", "File rollback is not allowed by the effect policy"));
    if (result.ok) {
      const event = instrumentation.span?.complete({ effectState: "applied", summary: result.data.summary });
      const meta = this.finishMeta(operationContext, "change.rollback", "write", "completed", { internalCalls: 1, filesChanged: changeset.files.length }, instrumentation, event?.timestamp, "applied", result.data.summary);
      return runtimeSuccess(result.data, meta);
    }
    const error = result.error;
    const event = instrumentation.span?.fail(error);
    return runtimeFailure(error, this.finishMeta(operationContext, "change.rollback", "write", "failed", { internalCalls: 1 }, instrumentation, event?.timestamp, error.effect, "ChangeSet rollback rejected"));
  }

  private searchWithRg(input: FileSearchInput, searchRoot: string, maxResults: number): SearchComputation | undefined {
    const args = ["--json", "--color", "never", "--no-heading", "--max-count", String(maxResults)];
    if (!input.regex) args.push("--fixed-strings");
    args.push(input.query, searchRoot);
    const processResult = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (processResult.error?.message.includes("ENOENT")) return undefined;
    const outputTruncated = processResult.error !== undefined && /maxbuffer|enobufs/i.test(processResult.error.message);
    if (processResult.error && !outputTruncated) throw processResult.error;
    if (!outputTruncated && processResult.status !== 0 && processResult.status !== 1) throw new Error(String(processResult.stderr) || "rg search failed");
    const matches: FileSearchMatch[] = [];
    for (const line of String(processResult.stdout).split("\n")) {
      if (line === "") continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (event === null || typeof event !== "object") continue;
      const value = event as Record<string, unknown>;
      if (value.type !== "match" || value.data === null || typeof value.data !== "object") continue;
      const data = value.data as Record<string, unknown>;
      const pathValue = data.path;
      const linesValue = data.lines;
      if (pathValue === null || typeof pathValue !== "object" || linesValue === null || typeof linesValue !== "object") continue;
      const pathText = (pathValue as Record<string, unknown>).text;
      const lineText = (linesValue as Record<string, unknown>).text;
      const lineNumber = data.line_number;
      if (typeof pathText !== "string" || typeof lineText !== "string" || typeof lineNumber !== "number") continue;
      const absolute = resolveConfinedPath(this.rootDir, pathText, false);
      matches.push({ path: relativeFile(this.rootDir, absolute), line: lineNumber, text: lineText.replace(/\n$/, "") });
      if (matches.length >= maxResults) break;
    }
    matches.sort(compareMatches);
    return { result: { query: input.query, matches, resultCount: matches.length, hasMore: outputTruncated || matches.length >= maxResults, truncated: outputTruncated || matches.length >= maxResults, backend: "rg", artifactRefs: [] }, rawOutputBytes: byteLength(String(processResult.stdout)) };
  }

  private searchFallback(input: FileSearchInput, searchRoot: string, maxResults: number): SearchComputation {
    const files: string[] = [];
    walk(searchRoot, this.rootDir, files);
    files.sort();
    const matches: FileSearchMatch[] = [];
    const expression = input.regex ? new RegExp(input.query) : undefined;
    for (const file of files) {
      const bytes = readFileSync(file);
      if (bytes.includes(0)) continue;
      const lines = new TextDecoder().decode(bytes).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index]!;
        const found = expression === undefined ? text.indexOf(input.query) : expression.exec(text)?.index ?? -1;
        if (found < 0) continue;
        matches.push({ path: relativeFile(this.rootDir, file), line: index + 1, column: found + 1, text });
        if (matches.length >= maxResults) return { result: { query: input.query, matches, resultCount: matches.length, hasMore: true, truncated: true, backend: "fallback", artifactRefs: [] }, rawOutputBytes: matches.reduce((total, match) => total + byteLength(JSON.stringify(match)), 0) };
      }
    }
    return { result: { query: input.query, matches, resultCount: matches.length, hasMore: false, truncated: false, backend: "fallback", artifactRefs: [] }, rawOutputBytes: matches.reduce((total, match) => total + byteLength(JSON.stringify(match)), 0) };
  }

  private putArtifact(content: Uint8Array, origin: string, context: OperationContext): readonly ArtifactRef[] {
    if (this.artifacts === undefined) return [];
    const artifact = this.artifacts.put(content, { mediaType: "text/plain", origin });
    this.tracer?.emit({ traceId: context.traceId, runId: context.runId, spanId: context.spanId ?? "span_uninstrumented" as import("../core/index.ts").SpanId, ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }), type: "artifact.created", actor: context.actor, ...(context.taskId === undefined ? {} : { taskId: context.taskId }), ...(context.projectId === undefined ? {} : { projectId: context.projectId }), artifactRefs: [artifact.ref], measurements: { artifactBytes: artifact.size }, metadata: { origin } });
    return [artifact.ref];
  }

  private start(operation: string, effectClass: "read" | "write", context: OperationContext, enabled: boolean): Instrumentation {
    if (!enabled || this.tracer === undefined) return { startedAt: new Date().toISOString(), context };
    const parentSpanId = context.spanId ?? context.parentSpanId;
    const span = this.tracer.startOperation({ traceId: context.traceId, runId: context.runId, actor: context.actor, operation, effectClass, ...(parentSpanId === undefined ? {} : { parentSpanId }), ...(context.taskId === undefined ? {} : { taskId: context.taskId }), ...(context.projectId === undefined ? {} : { projectId: context.projectId }), ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }), ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }), executor: "direct", provider: "node:fs" });
    return { span, startedAt: span.startedAt, context: { ...context, spanId: span.spanId, ...(parentSpanId === undefined ? {} : { parentSpanId }) } };
  }

  private finish(instrumentation: Instrumentation, context: OperationContext, operation: string, effectClass: "read" | "write", metrics: Record<string, number>, refs: readonly ArtifactRef[], status: "completed" | "failed", summary: string, effectState: "none" | "applied" = "none") {
    const event = instrumentation.span === undefined ? undefined : (() => { instrumentation.span.record(metrics); return instrumentation.span.complete({ artifactRefs: refs, effectState, summary }); })();
    return this.finishMeta(context, operation, effectClass, status, metrics, instrumentation, event?.timestamp, effectState, summary, refs, event?.durationMs);
  }

  private finishMeta(context: OperationContext, operation: string, effectClass: "read" | "write", status: "completed" | "failed", metrics: Record<string, number>, instrumentation: Instrumentation, completedAt: string | undefined, effectState: "none" | "unknown" | "applied", summary: string, refs: readonly ArtifactRef[] = [], eventDuration?: number) {
    return createOperationMeta({ context: { ...context, ...(instrumentation.span === undefined ? {} : { spanId: instrumentation.span.spanId }) }, operation, status, effectClass, effectState, startedAt: instrumentation.startedAt, completedAt: completedAt ?? new Date().toISOString(), metrics: { ...metrics, ...(eventDuration === undefined ? {} : { durationMs: eventDuration }) }, artifactRefs: refs, summary, truncated: false, executor: "direct", provider: "node:fs" });
  }

  private failure(instrumentation: Instrumentation, context: OperationContext, operation: string, effectClass: "read" | "write", error: RuntimeError, inputSize: number): RuntimeResult<never> {
    const event = instrumentation.span?.fail(error, { summary: error.message });
    return runtimeFailure(error, this.finishMeta(context, operation, effectClass, "failed", { internalCalls: 1, inputBytes: inputSize }, instrumentation, event?.timestamp, error.effect, error.message));
  }
}

export { FileOperations as FileService };

export function createFileService(options: FileOperationsOptions): FileOperations {
  return new FileOperations(options);
}

function compareMatches(left: FileSearchMatch, right: FileSearchMatch): number {
  return left.path.localeCompare(right.path) || left.line - right.line || (left.column ?? 0) - (right.column ?? 0) || left.text.localeCompare(right.text);
}

function boundSearchBytes(result: FileSearchResult, maxBytes: number | undefined): FileSearchResult {
  if (maxBytes === undefined) return result;
  const limit = validLimit(maxBytes, DEFAULT_MAX_FILE_READ_BYTES, "maxBytes");
  const matches: FileSearchMatch[] = [];
  for (const match of result.matches) {
    const candidate = [...matches, match];
    if (byteLength(JSON.stringify(candidate)) > limit) break;
    matches.push(match);
  }
  const hasMore = result.hasMore || matches.length < result.matches.length;
  return { ...result, matches, resultCount: matches.length, hasMore, truncated: result.truncated || hasMore };
}

function walk(directory: string, root: string, files: string[]): void {
  if (statSync(directory).isFile()) {
    files.push(resolveConfinedPath(root, relative(root, directory), false));
    return;
  }
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, root, files);
    else if (entry.isFile()) {
      const confined = resolveConfinedPath(root, relative(root, path), false);
      files.push(confined);
    }
  }
}

function atomicWrite(rootDir: string, path: string, content: Uint8Array): void {
  const parent = dirname(path);
  const confinedParent = resolveConfinedPath(rootDir, relative(rootDir, parent) || ".", false);
  if (confinedParent !== parent) throw createRuntimeError({ code: "FILE_PATH_ESCAPE", message: "Semantic file path parent changed outside the project root", retryable: false, effect: "none" });
  const directoryFd = openSync(parent, "r");
  const anchoredParent = `/proc/self/fd/${directoryFd}`;
  const temporaryName = `.aer-tmp-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temporary = join(anchoredParent, temporaryName);
  const destination = join(anchoredParent, basename(path));
  try {
    if (realpathSync(anchoredParent) !== parent) throw createRuntimeError({ code: "FILE_PATH_ESCAPE", message: "Semantic file path parent changed outside the project root", retryable: false, effect: "none" });
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(directoryFd);
  }
}

export function createFileOperations(options: FileOperationsOptions): FileOperations { return new FileOperations(options); }

export function createFileReadOperation(service: FileOperations): Operation<FileReadInput, FileReadResult> {
  return { name: "file.read", effectClass: "read", executor: "direct", provider: "node:fs", execute: (input, context) => service.read(input, context, { instrument: false }) };
}

export function createFileSearchOperation(service: FileOperations): Operation<FileSearchInput, FileSearchResult> {
  return { name: "file.search", effectClass: "read", executor: "direct", provider: "node:fs/rg", execute: (input, context) => service.search(input, context, { instrument: false }) };
}

export function createFilePatchOperation(service: FileOperations): Operation<FilePatchInput, FilePatchResult> {
  return { name: "file.patch", effectClass: "write", executor: "direct", provider: "node:fs", execute: (input, context) => service.patch(input, context, { instrument: false }) };
}

export function createRollbackOperation(service: FileOperations): Operation<{ readonly changeset: ChangeSet }, ChangeSet> {
  return { name: "change.rollback", effectClass: "write", executor: "direct", provider: "node:fs", execute: (input, context) => service.rollback(input.changeset, context, { instrument: false }) };
}

export function createFileOperationsList(service: FileOperations): readonly Operation<unknown, unknown>[] {
  return [createFileReadOperation(service) as Operation<unknown, unknown>, createFileSearchOperation(service) as Operation<unknown, unknown>, createFilePatchOperation(service) as Operation<unknown, unknown>, createRollbackOperation(service) as Operation<unknown, unknown>];
}
