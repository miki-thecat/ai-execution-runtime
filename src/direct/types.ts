import type { ArtifactRef, RunId, SpanId, TraceId } from "../core/ids.ts";
import type { EffectClass, EffectState } from "../core/effects.ts";

export type ProcessId = string & { readonly __brand: "ProcessId" };

export interface ExecutableCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Environment values are passed to the child but are never included in telemetry. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Compatibility input; the runtime always starts from its safe baseline. */
  /** Compatibility input; the runtime always starts from its safe baseline. */
  readonly inheritEnvironment?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export type StructuredCommand = ExecutableCommand;

export interface ShellRunInput {
  /** Raw shell source. This is intentionally an escape hatch. */
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnvironment?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface DirectExecutionOptions {
  readonly tracer?: import("../observability/tracer.ts").Tracer;
  readonly state?: import("../state/store.ts").StateStore;
  readonly artifacts?: import("../artifacts/store.ts").ArtifactStore;
  readonly defaultMaxOutputBytes?: number;
  readonly cancelGraceMs?: number;
  /** Reconciliation is enabled by default when a durable state store is supplied. */
  readonly reconcileOnStart?: boolean;
  readonly credentialClassifiers?: readonly import("../policy/environment.ts").CredentialClassifier[];
}

/** Semantic providers may narrow the conservative raw-execution default. */
export interface DirectRunOptions {
  readonly instrument?: boolean;
  readonly effectClass?: EffectClass;
}

export type ProcessTerminalStatus = "completed" | "failed" | "cancelled" | "unknown";

export interface ProcessResult {
  readonly processId: ProcessId;
  readonly status: ProcessTerminalStatus;
  readonly effectState: EffectState;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly returnedOutputBytes: number;
  readonly rawOutputBytes: number;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly artifactBytes: number;
  readonly truncated: boolean;
  /** Bytes received after the runtime's raw capture ceiling. */
  readonly discardedOutputBytes: number;
  readonly capturedOutputBytes: number;
  readonly truncationReason?: "returned_output_limit" | "raw_capture_limit" | "artifact_unavailable";
  readonly environment?: import("../policy/environment.ts").EnvironmentEvidence;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly error?: string;
}

export interface ProcessHandle {
  readonly processId: ProcessId;
  readonly pid?: number;
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly spanId: SpanId;
  wait(): Promise<ProcessResult>;
  cancel(reason?: "cancel" | "timeout"): Promise<ProcessResult>;
}

export interface ShellRunResult extends ProcessResult {
  readonly command: string;
}

export interface ExecutableRunResult extends ProcessResult {
  readonly executable: string;
  readonly args: readonly string[];
}
