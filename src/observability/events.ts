import type {
  ArtifactRef,
  DeviceId,
  EventId,
  ProjectId,
  RunId,
  SpanId,
  TaskId,
  TraceId,
} from "../core/ids.ts";
import type { EffectClass, EffectState, PolicyDecision, PolicyDecisionEvidence } from "../core/effects.ts";
import {
  createEventId,
  type OperationId,
} from "../core/ids.ts";
import type { Actor } from "../core/context.ts";
import type { EnvironmentEvidence } from "../policy/environment.ts";
import {
  emptyOperationMeasurements,
  type OperationMeasurements,
  type RuntimeStatus,
} from "../core/result.ts";

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EVENT_TYPES = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.unknown",
  "task.created",
  "task.started",
  "task.blocked",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.unknown",
  "operation.started",
  "operation.completed",
  "operation.failed",
  "operation.cancelled",
  "operation.unknown",
  "process.started",
  "process.completed",
  "process.cancelled",
  "process.unknown",
  "artifact.created",
  "changeset.created",
  "changeset.applied",
  "changeset.rolled_back",
  "verification.started",
  "verification.completed",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "approval.requested",
  "approval.resolved",
  "device.connected",
  "device.disconnected",
  "remote.requested",
  "remote.completed",
  "mcp.presented",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface RuntimeEvent {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly eventId: EventId;
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly timestamp: string;
  readonly type: EventType;
  readonly actor: Actor;
  readonly projectId?: ProjectId;
  readonly deviceId?: DeviceId;
  readonly operation?: string;
  readonly operationId?: OperationId;
  readonly executor?: string;
  readonly provider?: string;
  readonly status?: RuntimeStatus;
  readonly summary?: string;
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
  readonly effectClass?: EffectClass;
  readonly effectState?: EffectState;
  readonly policyDecision?: PolicyDecision;
  readonly policyEvidence?: PolicyDecisionEvidence;
  readonly environment?: EnvironmentEvidence;
  readonly idempotencyKey?: string;
  readonly changesetId?: string;
  readonly verificationId?: string;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Optional content payload. Tracer only includes this after explicit opt-in. */
  readonly payload?: unknown;
}

export interface RuntimeEventInput {
  readonly eventId?: EventId;
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly timestamp?: string;
  readonly type: EventType;
  readonly actor: Actor;
  readonly projectId?: ProjectId;
  readonly deviceId?: DeviceId;
  readonly operation?: string;
  readonly operationId?: OperationId;
  readonly executor?: string;
  readonly provider?: string;
  readonly status?: RuntimeStatus;
  readonly summary?: string;
  readonly measurements?: Partial<OperationMeasurements>;
  readonly effectClass?: EffectClass;
  readonly effectState?: EffectState;
  readonly policyDecision?: PolicyDecision;
  readonly policyEvidence?: PolicyDecisionEvidence;
  readonly environment?: EnvironmentEvidence;
  readonly idempotencyKey?: string;
  readonly changesetId?: string;
  readonly verificationId?: string;
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly payload?: unknown;
}

export function createRuntimeEvent(input: RuntimeEventInput): RuntimeEvent {
  const measurements = { ...emptyOperationMeasurements(), ...input.measurements };
  measurements.compressionRatio =
    measurements.rawOutputBytes / Math.max(measurements.returnedOutputBytes, 1);

  return Object.freeze({
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: input.eventId ?? createEventId(),
    traceId: input.traceId,
    runId: input.runId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    spanId: input.spanId,
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    actor: input.actor,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.executor === undefined ? {} : { executor: input.executor }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    durationMs: measurements.durationMs,
    internalCalls: measurements.internalCalls,
    retries: measurements.retries,
    pollCountInternal: measurements.pollCountInternal,
    pollCountModel: measurements.pollCountModel,
    inputBytes: measurements.inputBytes,
    rawOutputBytes: measurements.rawOutputBytes,
    returnedOutputBytes: measurements.returnedOutputBytes,
    artifactBytes: measurements.artifactBytes,
    filesRead: measurements.filesRead,
    filesChanged: measurements.filesChanged,
    ...(measurements.exitCode === undefined ? {} : { exitCode: measurements.exitCode }),
    ...(measurements.signal === undefined ? {} : { signal: measurements.signal }),
    ...(measurements.tokenInput === undefined ? {} : { tokenInput: measurements.tokenInput }),
    ...(measurements.tokenOutput === undefined ? {} : { tokenOutput: measurements.tokenOutput }),
    ...(measurements.tokenCached === undefined ? {} : { tokenCached: measurements.tokenCached }),
    compressionRatio: measurements.compressionRatio,
    ...(input.effectClass === undefined ? {} : { effectClass: input.effectClass }),
    ...(input.effectState === undefined ? {} : { effectState: input.effectState }),
    ...(input.policyDecision === undefined ? {} : { policyDecision: input.policyDecision }),
    ...(input.policyEvidence === undefined ? {} : { policyEvidence: input.policyEvidence }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(input.changesetId === undefined ? {} : { changesetId: input.changesetId }),
    ...(input.verificationId === undefined ? {} : { verificationId: input.verificationId }),
    artifactRefs: [...(input.artifactRefs ?? [])],
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
}

export interface EventSink {
  append(event: RuntimeEvent): void;
}

export class InMemoryEventSink implements EventSink {
  private readonly entries: RuntimeEvent[] = [];

  append(event: RuntimeEvent): void {
    this.entries.push(event);
  }

  get events(): readonly RuntimeEvent[] {
    return [...this.entries];
  }
}
