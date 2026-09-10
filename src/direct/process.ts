import { spawn, type ChildProcessLike, type SpawnOptions } from "node:child_process";
import { kill as killProcess, platform } from "node:process";
import { closeSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationId, createSpanId, type ArtifactRef } from "../core/ids.ts";
import { createRuntimeError, type OperationContext, type RuntimeError } from "../core/index.ts";
import { policyDecisionEvidence, type EffectClass } from "../core/effects.ts";
import { buildChildEnvironment, type EnvironmentEvidence } from "../policy/environment.ts";
import { narrowBudget } from "../policy/budgets.ts";
import { FileArtifactStore, type ArtifactStore } from "../artifacts/store.ts";
import type { StateStore } from "../state/store.ts";
import { Tracer } from "../observability/tracer.ts";
import type { ProcessHandle, ProcessId, ProcessResult } from "./types.ts";
import type { ExecutableCommand } from "./types.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
export const MAX_RAW_CAPTURE_BYTES = 1 * 1024 * 1024;
export const DEFAULT_CANCEL_GRACE_MS = 250;
const ARTIFACT_CHUNK_BYTES = 64 * 1024;

export interface ProcessStartOptions {
  readonly command: ExecutableCommand;
  readonly shell?: boolean | string;
  readonly operation: string;
  readonly context: OperationContext;
  readonly effectClass?: EffectClass;
  readonly maxOutputBytes?: number;
  readonly maxRawOutputBytes?: number;
  readonly environmentEvidence?: EnvironmentEvidence;
  readonly credentialClassifiers?: readonly import("../policy/environment.ts").CredentialClassifier[];
}

interface ProcessRecord {
  readonly processId: ProcessId;
  readonly pid?: number;
  readonly operation: string;
  readonly commandKind: "shell" | "executable";
  readonly argumentCount: number;
  readonly cwd?: string;
  readonly startedAt: string;
  readonly traceId: string;
  readonly runId: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly spanId: string;
  readonly operationId: string;
  readonly effectClass: EffectClass;
  readonly reattachable: false;
}

class OutputCollector {
  private readonly returned: Uint8Array;
  private returnedBytes = 0;
  private total = 0;
  private readonly maxBytes: number;
  private readonly captureLimit: number;
  private readonly path: string;
  private file: number | undefined;
  private stored = 0;

  constructor(maxBytes: number, captureLimit: number, id: ProcessId, stream: "stdout" | "stderr") {
    this.maxBytes = maxBytes;
    this.captureLimit = captureLimit;
    this.returned = new Uint8Array(maxBytes);
    this.path = join(tmpdir(), `aer-direct-${id}-${stream}-${Date.now()}`);
    this.file = openSync(this.path, "wx", 0o600);
  }

  add(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    this.total += bytes.byteLength;
    const storable = Math.min(bytes.byteLength, Math.max(0, this.captureLimit - this.stored));
    let offset = 0;
    while (offset < storable) {
      const written = writeSync(this.file!, bytes, offset, storable - offset);
      if (written <= 0) throw new Error("Unable to spill process output");
      offset += written;
    }
    this.stored += storable;
    if (this.returnedBytes < this.maxBytes) {
      const count = Math.min(this.maxBytes - this.returnedBytes, bytes.byteLength);
      this.returned.set(bytes.subarray(0, count), this.returnedBytes);
      this.returnedBytes += count;
    }
  }

  get byteLength(): number { return this.total; }
  get capturedByteLength(): number { return this.stored; }
  get discardedByteLength(): number { return this.total - this.stored; }

  boundedBytes(): Uint8Array {
    this.close();
    return this.returned.slice(0, this.returnedBytes);
  }

  spill(put: (bytes: Uint8Array) => void): void {
    this.close();
    if (this.stored <= this.maxBytes) {
      this.remove();
      return;
    }
    const file = openSync(this.path, "r");
    try {
      const buffer = new Uint8Array(ARTIFACT_CHUNK_BYTES);
      let offset = 0;
      while (offset < this.stored) {
        const count = readSync(file, buffer, 0, Math.min(buffer.byteLength, this.stored - offset), offset);
        if (count === 0) throw new Error("Unable to read spilled process output");
        put(buffer.slice(0, count));
        offset += count;
      }
    } finally {
      closeSync(file);
      this.remove();
    }
  }

  cleanup(): void {
    this.close();
    this.remove();
  }

  private close(): void {
    if (this.file !== undefined) {
      closeSync(this.file);
      this.file = undefined;
    }
  }

  private remove(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // The file may already have been removed after a completed artifact write.
    }
  }
}

function processId(): ProcessId {
  return ("process_" + createOperationId().slice("op_".length)) as ProcessId;
}

function validByteLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("maxOutputBytes must be a non-negative integer");
  return limit;
}

function validTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("timeoutMs must be a non-negative integer");
  return value;
}

function safeEnvironment(
  values: Readonly<Record<string, string | undefined>> | undefined,
  inherit: boolean,
  operation: string,
  policy: OperationContext["effectPolicy"],
  classifiers: readonly import("../policy/environment.ts").CredentialClassifier[],
): { readonly values: Readonly<Record<string, string | undefined>>; readonly evidence: EnvironmentEvidence } {
  return buildChildEnvironment({ operation, inheritEnvironment: inherit, policy, classifiers, ...(values === undefined ? {} : { values }) });
}

function metadataFor(
  command: ExecutableCommand,
  args: readonly string[],
  environment: EnvironmentEvidence,
  shell: boolean,
): Record<string, unknown> {
  return {
    commandKind: shell ? "shell" : "executable",
    ...(shell ? {} : { executable: command.executable }),
    argumentCount: args.length,
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    environment: {
      baselineKeys: environment.baselineKeys,
      granted: environment.granted,
      withheld: environment.withheld,
      valueLogging: environment.valueLogging,
    },
  };
}

function stateData(record: ProcessRecord, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...record, status, ...extra };
}

export class DirectProcessManager {
  readonly tracer: Tracer;
  private readonly state: StateStore | undefined;
  private readonly artifacts: ArtifactStore | undefined;
  private readonly defaultMaxOutputBytes: number;
  private readonly cancelGraceMs: number;
  private readonly credentialClassifiers: readonly import("../policy/environment.ts").CredentialClassifier[];
  private readonly handles = new Map<ProcessId, ProcessHandle>();

  constructor(options: {
    readonly tracer?: Tracer;
    readonly state?: StateStore;
    readonly artifacts?: ArtifactStore;
    readonly defaultMaxOutputBytes?: number;
    readonly cancelGraceMs?: number;
    readonly reconcileOnStart?: boolean;
    readonly credentialClassifiers?: readonly import("../policy/environment.ts").CredentialClassifier[];
  } = {}) {
    this.tracer = options.tracer ?? new Tracer();
    this.state = options.state;
    this.artifacts = options.artifacts ?? new FileArtifactStore();
    this.defaultMaxOutputBytes = Math.min(validByteLimit(options.defaultMaxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES), DEFAULT_MAX_OUTPUT_BYTES);
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.credentialClassifiers = options.credentialClassifiers ?? [];
    if (!Number.isSafeInteger(this.cancelGraceMs) || this.cancelGraceMs < 0) throw new RangeError("cancelGraceMs must be a non-negative integer");
    if (options.reconcileOnStart !== false) this.reconcile();
  }

  start(options: ProcessStartOptions): ProcessHandle {
    const effectClass = options.effectClass ?? "destructive";
    const policyEvidence = policyDecisionEvidence(options.context.effectPolicy, effectClass);
    if (policyEvidence.decision !== "allow") {
      throw createRuntimeError({
        code: policyEvidence.decision === "approval_required" ? "EFFECT_APPROVAL_REQUIRED" : "EFFECT_NOT_ALLOWED",
        message: policyEvidence.reason,
        retryable: false,
        effect: "none",
        details: { ...policyEvidence },
      });
    }
    const requestedOutputBytes = narrowBudget(options.maxOutputBytes ?? options.command.maxOutputBytes, Math.min(this.defaultMaxOutputBytes, options.context.budgets.maxOutputBytes), "maxOutputBytes");
    // stdout and stderr are returned together, so a narrowed aggregate
    // ceiling must be divided across the two streams.
    const maxOutputBytes = Math.min(requestedOutputBytes, Math.floor(options.context.budgets.maxReturnedOutputBytes / 2));
    const maxRawOutputBytes = narrowBudget(options.maxRawOutputBytes, Math.min(MAX_RAW_CAPTURE_BYTES, options.context.budgets.maxRawOutputBytes, options.context.budgets.maxArtifactBytes), "maxRawOutputBytes");
    const timeoutMs = validTimeout(options.command.timeoutMs);
    const args = [...(options.command.args ?? [])];
    const environment = safeEnvironment(options.command.env, options.command.inheritEnvironment !== false, options.operation, options.context.effectPolicy, options.credentialClassifiers ?? this.credentialClassifiers);
    const env = environment.values;
    const id = processId();
    const spanId = createSpanId();
    const operationId = createOperationId();
    const startedAt = this.tracer.now();
    const record: ProcessRecord = {
      processId: id,
      operation: options.operation,
      commandKind: options.shell === undefined || options.shell === false ? "executable" : "shell",
      argumentCount: args.length,
      ...(options.command.cwd === undefined ? {} : { cwd: options.command.cwd }),
      startedAt: startedAt.toISOString(),
      traceId: options.context.traceId,
      runId: options.context.runId,
      ...(options.context.projectId === undefined ? {} : { projectId: options.context.projectId }),
      ...(options.context.taskId === undefined ? {} : { taskId: options.context.taskId }),
      spanId,
      operationId,
      effectClass,
      reattachable: false,
    };
    const spawnOptions: SpawnOptions = {
      ...(options.command.cwd === undefined ? {} : { cwd: options.command.cwd }),
      ...(env === undefined ? {} : { env }),
      shell: options.shell ?? false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    };

    // Establish a durable restart-reconciliation point before creating the
    // detached child. If the runtime stops after spawn but before the running
    // update below, this queued record is enough for a new runtime to mark the
    // process UNKNOWN rather than losing track of a live process.
    this.persist(record, "queued");

    let child: ChildProcessLike;
    try {
      child = spawn(options.command.executable, args, spawnOptions);
    } catch (error) {
      this.persist(record, "failed", { errorCode: "PROCESS_SPAWN_FAILED", error: "Process could not be started" });
      throw this.spawnError(error);
    }

    // Keep the combined stdout/stderr capture below the runtime ceiling.
    const streamCaptureLimit = Math.floor(maxRawOutputBytes / 2);
    const stdout = new OutputCollector(maxOutputBytes, streamCaptureLimit, id, "stdout");
    const stderr = new OutputCollector(maxOutputBytes, streamCaptureLimit, id, "stderr");
    child.stdout?.on("data", (chunk) => stdout.add(chunk));
    child.stderr?.on("data", (chunk) => stderr.add(chunk));
    const runningRecord: ProcessRecord = { ...record, ...(child.pid === undefined ? {} : { pid: child.pid }) };
    this.persist(runningRecord, "running");
    this.tracer.emit({
      traceId: options.context.traceId,
      runId: options.context.runId,
      spanId,
      ...(options.context.spanId === undefined ? {} : { parentSpanId: options.context.spanId }),
      type: "process.started",
      actor: options.context.actor,
      ...(options.context.taskId === undefined ? {} : { taskId: options.context.taskId }),
      ...(options.context.projectId === undefined ? {} : { projectId: options.context.projectId }),
      ...(options.context.deviceId === undefined ? {} : { deviceId: options.context.deviceId }),
      operation: options.operation,
      operationId,
      status: "running",
      executor: "direct",
      provider: "node:child_process",
      effectClass,
      effectState: "none",
      policyDecision: policyEvidence.decision,
      policyEvidence,
      environment: environment.evidence,
      metadata: { ...metadataFor(options.command, args, environment.evidence, options.shell !== undefined && options.shell !== false), pid: child.pid, processId: id },
    });

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveWait!: (result: ProcessResult) => void;
    const waitPromise = new Promise<ProcessResult>((resolve) => { resolveWait = resolve; });
    const finish = (code: number | null, signal: string | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      const stdoutBytes = stdout.byteLength;
      const stderrBytes = stderr.byteLength;
      const refs: ArtifactRef[] = [];
      let artifactBytes = 0;
      let finalizationError = error;
      try {
        if (stdoutBytes > maxOutputBytes && this.artifacts !== undefined) {
          stdout.spill((bytes) => {
            const artifact = this.putArtifact(bytes, "stdout", options, id);
            refs.push(artifact.ref);
            artifactBytes += artifact.size;
          });
        } else stdout.cleanup();
        if (stderrBytes > maxOutputBytes && this.artifacts !== undefined) {
          stderr.spill((bytes) => {
            const artifact = this.putArtifact(bytes, "stderr", options, id);
            refs.push(artifact.ref);
            artifactBytes += artifact.size;
          });
        } else stderr.cleanup();
      } catch {
        finalizationError = "Process output artifact persistence failed";
      } finally {
        stdout.cleanup();
        stderr.cleanup();
      }
      const endedAt = this.tracer.now();
      const status = cancelled ? "cancelled" : finalizationError === undefined ? "completed" : "unknown";
      const effectState = status === "completed" ? "applied" : "unknown";
      const returnedOutputBytes = Math.min(stdoutBytes, maxOutputBytes) + Math.min(stderrBytes, maxOutputBytes);
      const discardedOutputBytes = stdout.discardedByteLength + stderr.discardedByteLength;
      const truncated = stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes || discardedOutputBytes > 0;
      const result: ProcessResult = {
        processId: id,
        status,
        effectState,
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
        stdout: new TextDecoder().decode(stdout.boundedBytes()),
        stderr: new TextDecoder().decode(stderr.boundedBytes()),
        stdoutBytes,
        stderrBytes,
        returnedOutputBytes,
        rawOutputBytes: stdoutBytes + stderrBytes,
        artifactRefs: refs,
        artifactBytes,
        truncated,
        discardedOutputBytes,
        capturedOutputBytes: stdout.capturedByteLength + stderr.capturedByteLength,
        environment: environment.evidence,
        ...(discardedOutputBytes > 0 ? { truncationReason: "raw_capture_limit" as const } : stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes ? { truncationReason: "returned_output_limit" as const } : {}),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        timedOut,
        cancelled,
        ...(finalizationError === undefined ? {} : { error: finalizationError }),
      };
      try {
        this.persist(runningRecord, status, {
          completedAt: endedAt.toISOString(),
          ...(code === null ? {} : { exitCode: code }),
          ...(signal === null ? {} : { signal }),
          timedOut,
          cancelled,
          artifactRefs: refs,
          rawOutputBytes: result.rawOutputBytes,
          returnedOutputBytes,
          effectState,
          ...(finalizationError === undefined ? {} : { errorCode: "PROCESS_FINALIZATION_FAILED", error: "Process finalization failed" }),
        });
        this.tracer.emit({
        traceId: options.context.traceId,
        runId: options.context.runId,
        spanId,
        ...(options.context.spanId === undefined ? {} : { parentSpanId: options.context.spanId }),
        type: cancelled ? "process.cancelled" : status === "unknown" ? "process.unknown" : "process.completed",
        actor: options.context.actor,
        ...(options.context.taskId === undefined ? {} : { taskId: options.context.taskId }),
        ...(options.context.projectId === undefined ? {} : { projectId: options.context.projectId }),
        ...(options.context.deviceId === undefined ? {} : { deviceId: options.context.deviceId }),
        operation: options.operation,
        operationId,
        status,
        executor: "direct",
        provider: "node:child_process",
        ...(finalizationError === undefined ? {} : { summary: "Process finalization failed" }),
        measurements: {
          durationMs: result.durationMs,
          internalCalls: 1,
          rawOutputBytes: result.rawOutputBytes,
          returnedOutputBytes,
          artifactBytes,
          ...(code === null ? {} : { exitCode: code }),
          ...(signal === null ? {} : { signal }),
        },
        artifactRefs: refs,
          effectClass,
          effectState,
          policyDecision: policyEvidence.decision,
          policyEvidence,
          metadata: { processId: id, timedOut, cancelled, capturedOutputBytes: result.capturedOutputBytes, discardedOutputBytes, rawCaptureLimitBytes: maxRawOutputBytes, ...(result.truncationReason === undefined ? {} : { truncationReason: result.truncationReason }) },
        });
      } finally {
        this.handles.delete(id);
        resolveWait(result);
      }
    };
    child.on("error", (error) => finish(child.exitCode, child.signalCode, error.message));
    child.on("close", (code, signal) => finish(code, signal));

    const terminate = (signal: string): void => {
      if (child.pid !== undefined && platform !== "win32") {
        try {
          killProcess(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child when process-group signalling is unavailable.
        }
      }
      if (!child.killed) child.kill(signal);
    };
    const requestCancel = (reason: "cancel" | "timeout" = "cancel"): void => {
      if (settled) return;
      cancelled = true;
      terminate("SIGTERM");
      forceTimer = setTimeout(() => {
        if (!settled) terminate("SIGKILL");
      }, this.cancelGraceMs);
      if (reason === "timeout") timedOut = true;
    };
    const remainingDeadlineMs = options.context.deadline === undefined
      ? undefined
      : Math.max(0, options.context.deadline - Date.now());
    const effectiveTimeoutMs = timeoutMs === undefined
      ? remainingDeadlineMs
      : remainingDeadlineMs === undefined
        ? timeoutMs
        : Math.min(timeoutMs, remainingDeadlineMs);
    if (effectiveTimeoutMs === 0) requestCancel("timeout");
    else if (effectiveTimeoutMs !== undefined) timer = setTimeout(() => requestCancel("timeout"), effectiveTimeoutMs);
    const abort = (): void => requestCancel("cancel");
    if (options.context.signal.aborted) abort();
    else options.context.signal.addEventListener("abort", abort, { once: true });
    const handle: ProcessHandle = {
      processId: id,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      traceId: options.context.traceId,
      runId: options.context.runId,
      spanId,
      wait: () => waitPromise,
      cancel: (reason = "cancel") => {
        requestCancel(reason);
        return waitPromise;
      },
    };
    this.handles.set(id, handle);
    return handle;
  }

  reconcile(): readonly ProcessId[] {
    if (this.state === undefined) return [];
    const orphaned: ProcessId[] = [];
    for (const entity of this.state.listEntities("processes", { order: "desc" })) {
      if (entity.status !== "running" && entity.status !== "queued") continue;
      const data = entity.data as Partial<ProcessRecord> | undefined;
      if (data?.traceId === undefined || data.runId === undefined || data.spanId === undefined) continue;
      const id = entity.id as ProcessId;
      const projectId = data.projectId ?? entity.projectId;
      const taskId = data.taskId ?? entity.taskId;
      const reconciled: ProcessRecord = {
        processId: id,
        ...(typeof data.pid === "number" ? { pid: data.pid } : {}),
        operation: typeof data.operation === "string" ? data.operation : "process.run",
        commandKind: data.commandKind === "shell" ? "shell" : "executable",
        argumentCount: typeof data.argumentCount === "number" && Number.isSafeInteger(data.argumentCount) && data.argumentCount >= 0 ? data.argumentCount : 0,
        ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {}),
        startedAt: typeof data.startedAt === "string" ? data.startedAt : entity.createdAt ?? new Date().toISOString(),
        traceId: data.traceId,
        runId: data.runId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(taskId === undefined ? {} : { taskId }),
        spanId: data.spanId,
        operationId: typeof data.operationId === "string" ? data.operationId : createOperationId(),
        effectClass: data.effectClass === "read" || data.effectClass === "workspace_write" || data.effectClass === "network" || data.effectClass === "remote_write" || data.effectClass === "destructive" || data.effectClass === "privileged" ? data.effectClass : "destructive",
        reattachable: false,
      };
      orphaned.push(id);
      this.persist(reconciled, "unknown", {
        orphaned: true,
        orphanReason: "Process handles cannot be safely reattached after runtime restart",
      });
      this.tracer.emit({
        traceId: data.traceId as import("../core/ids.ts").TraceId,
        runId: data.runId as import("../core/ids.ts").RunId,
        spanId: data.spanId as import("../core/ids.ts").SpanId,
        type: "process.unknown",
        actor: "runtime",
        ...(projectId === undefined ? {} : { projectId: projectId as import("../core/ids.ts").ProjectId }),
        ...(taskId === undefined ? {} : { taskId: taskId as import("../core/ids.ts").TaskId }),
        operation: reconciled.operation,
        operationId: reconciled.operationId as import("../core/ids.ts").OperationId,
        status: "unknown",
        executor: "direct",
        provider: "node:child_process",
        effectState: "unknown",
        effectClass: reconciled.effectClass,
        summary: "Process was orphaned during runtime restart; reattachment is unsafe",
        metadata: { processId: id, orphaned: true },
      });
    }
    return orphaned;
  }

  private persist(record: ProcessRecord, status: string, extra: Record<string, unknown> = {}): void {
    this.state?.saveEntity({
      kind: "processes",
      id: record.processId,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      runId: record.runId,
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
      status,
      createdAt: record.startedAt,
      updatedAt: new Date().toISOString(),
      traceId: record.traceId,
      data: stateData(record, status, extra),
    });
  }

  private putArtifact(bytes: Uint8Array, stream: "stdout" | "stderr", options: ProcessStartOptions, id: ProcessId) {
    if (this.artifacts === undefined) throw new Error("Output artifact store is unavailable");
    const artifact = this.artifacts.put(bytes, {
      ...(options.context.projectId === undefined ? {} : { projectId: options.context.projectId }),
      mediaType: "text/plain",
      origin: "direct.process." + stream,
      sensitivity: "sensitive",
    });
    this.tracer.emit({
      traceId: options.context.traceId,
      runId: options.context.runId,
      spanId: options.context.spanId ?? createSpanId(),
      ...(options.context.spanId === undefined ? {} : { parentSpanId: options.context.spanId }),
      type: "artifact.created",
      actor: options.context.actor,
      operation: options.operation,
      status: "completed",
      artifactRefs: [artifact.ref],
      measurements: { rawOutputBytes: bytes.byteLength, artifactBytes: bytes.byteLength },
      metadata: { processId: id, stream, size: bytes.byteLength },
    });
    return artifact;
  }

  private spawnError(error: unknown): RuntimeError {
    return createRuntimeError({
      code: "PROCESS_SPAWN_FAILED",
      message: error instanceof Error ? error.message : "Process could not be started",
      retryable: false,
      effect: "none",
    });
  }
}

export { DirectProcessManager as ProcessManager };
