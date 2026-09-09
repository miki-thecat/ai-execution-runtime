import type {
  ArtifactRef,
  DeviceId,
  ProjectId,
  RunId,
  SpanId,
  TaskId,
  TraceId,
} from "./ids.ts";
import type { EffectClass, EffectState, PolicyDecision, PolicyDecisionEvidence } from "./effects.ts";
import type { OperationContext } from "./context.ts";

export type RuntimeStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_user"
  | "blocked"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type OperationStatus = Extract<RuntimeStatus, "completed" | "failed" | "cancelled" | "unknown">;

export interface OperationMeasurements {
  readonly durationMs: number;
  readonly internalCalls: number;
  readonly retries: number;
  readonly pollCountInternal: number;
  readonly pollCountModel: number;
  readonly inputBytes: number;
  readonly rawOutputBytes: number;
  readonly returnedOutputBytes: number;
  readonly artifactBytes: number;
  readonly filesRead: number;
  readonly filesChanged: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly tokenInput?: number;
  readonly tokenOutput?: number;
  readonly tokenCached?: number;
  readonly compressionRatio: number;
}

export function emptyOperationMeasurements(): OperationMeasurements {
  return {
    durationMs: 0,
    internalCalls: 0,
    retries: 0,
    pollCountInternal: 0,
    pollCountModel: 0,
    inputBytes: 0,
    rawOutputBytes: 0,
    returnedOutputBytes: 0,
    artifactBytes: 0,
    filesRead: 0,
    filesChanged: 0,
    compressionRatio: 0,
  };
}

export interface RuntimeErrorInit {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly effect: EffectState;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly effect: EffectState;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class RuntimeErrorException extends Error implements RuntimeError {
  readonly code: string;
  readonly retryable: boolean;
  readonly effect: EffectState;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(init: RuntimeErrorInit) {
    super(init.message);
    this.name = "RuntimeError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.effect = init.effect;
    if (init.details !== undefined) this.details = init.details;
  }
}

export const createRuntimeError = (init: RuntimeErrorInit): RuntimeError => Object.freeze({
  code: init.code,
  message: init.message,
  retryable: init.retryable,
  effect: init.effect,
  ...(init.details === undefined ? {} : { details: init.details }),
});

export function isRuntimeError(value: unknown): value is RuntimeError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeError>;
  return typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean" &&
    (candidate.effect === "none" || candidate.effect === "unknown" || candidate.effect === "applied");
}

export interface OperationMeta {
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly taskId?: TaskId;
  readonly projectId?: ProjectId;
  readonly deviceId?: DeviceId;
  readonly operation: string;
  readonly status: OperationStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly effectClass: EffectClass;
  readonly effectState: EffectState;
  readonly policyDecision?: PolicyDecision;
  readonly policyEvidence?: PolicyDecisionEvidence;
  readonly idempotencyKey?: string;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metrics: OperationMeasurements;
  readonly summary?: string;
  readonly truncated: boolean;
  readonly executor?: string;
  readonly provider?: string;
  readonly verificationId?: string;
}

export interface OperationMetaInit {
  readonly context: OperationContext;
  readonly operation: string;
  readonly status: OperationStatus;
  readonly effectClass: EffectClass;
  readonly effectState?: EffectState;
  readonly policyDecision?: PolicyDecision;
  readonly policyEvidence?: PolicyDecisionEvidence;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly metrics?: Partial<OperationMeasurements>;
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly summary?: string;
  readonly truncated?: boolean;
  readonly executor?: string;
  readonly provider?: string;
  readonly verificationId?: string;
}

export function createOperationMeta(init: OperationMetaInit): OperationMeta {
  const metrics = { ...emptyOperationMeasurements(), ...init.metrics };
  metrics.compressionRatio =
    metrics.rawOutputBytes / Math.max(metrics.returnedOutputBytes, 1);

  return {
    traceId: init.context.traceId,
    runId: init.context.runId,
    spanId: init.context.spanId ?? ("span_uninstrumented" as SpanId),
    ...(init.context.parentSpanId === undefined ? {} : { parentSpanId: init.context.parentSpanId }),
    ...(init.context.taskId === undefined ? {} : { taskId: init.context.taskId }),
    ...(init.context.projectId === undefined ? {} : { projectId: init.context.projectId }),
    ...(init.context.deviceId === undefined ? {} : { deviceId: init.context.deviceId }),
    operation: init.operation,
    status: init.status,
    startedAt: init.startedAt ?? new Date().toISOString(),
    ...(init.completedAt === undefined ? {} : { completedAt: init.completedAt }),
    effectClass: init.effectClass,
    effectState: init.effectState ?? "none",
    ...(init.policyDecision === undefined ? {} : { policyDecision: init.policyDecision }),
    ...(init.policyEvidence === undefined ? {} : { policyEvidence: init.policyEvidence }),
    ...(init.context.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: init.context.idempotencyKey }),
    artifactRefs: [...(init.artifactRefs ?? [])],
    metrics,
    ...(init.summary === undefined ? {} : { summary: init.summary }),
    truncated: init.truncated ?? false,
    ...(init.executor === undefined ? {} : { executor: init.executor }),
    ...(init.provider === undefined ? {} : { provider: init.provider }),
    ...(init.verificationId === undefined ? {} : { verificationId: init.verificationId }),
  };
}

export interface RuntimeSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: OperationMeta;
}

export interface RuntimeFailure {
  readonly ok: false;
  readonly error: RuntimeError;
  readonly meta: OperationMeta;
}

export type RuntimeResult<T> = RuntimeSuccess<T> | RuntimeFailure;

export const runtimeSuccess = <T>(data: T, meta: OperationMeta): RuntimeSuccess<T> => ({
  ok: true,
  data,
  meta,
});

export const runtimeFailure = (error: RuntimeError, meta: OperationMeta): RuntimeFailure => ({
  ok: false,
  error,
  meta,
});
