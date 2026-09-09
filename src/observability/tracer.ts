import type { Actor } from "../core/context.ts";
import type { EffectClass, EffectState, PolicyDecision, PolicyDecisionEvidence } from "../core/effects.ts";
import {
  createRunId,
  createSpanId,
  createTraceId,
  type ArtifactRef,
  type DeviceId,
  type ProjectId,
  type RunId,
  type SpanId,
  type TaskId,
  type TraceId,
} from "../core/ids.ts";
import type { OperationMeasurements, RuntimeError } from "../core/result.ts";
import { MetricsAccumulator } from "./metrics.ts";
import {
  createRuntimeEvent,
  type EventSink,
  InMemoryEventSink,
  type RuntimeEvent,
  type RuntimeEventInput,
} from "./events.ts";
import { Redactor, sanitizeDurableText, type Sensitivity } from "./redaction.ts";

export interface TracerOptions {
  readonly sink?: EventSink;
  readonly redactor?: Redactor;
  readonly clock?: () => Date;
}

interface IdentityOptions {
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly projectId?: ProjectId;
  readonly deviceId?: DeviceId;
  readonly actor: Actor;
}

export interface RunStartOptions {
  readonly traceId?: TraceId;
  readonly runId?: RunId;
  readonly taskId?: TaskId;
  readonly projectId?: ProjectId;
  readonly deviceId?: DeviceId;
  readonly actor?: Actor;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OperationStartOptions extends IdentityOptions {
  readonly operation: string;
  readonly parentSpanId?: SpanId;
  readonly effectClass: EffectClass;
  readonly effectState?: EffectState;
  readonly policyDecision?: PolicyDecision;
  readonly policyEvidence?: PolicyDecisionEvidence;
  readonly idempotencyKey?: string;
  readonly executor?: string;
  readonly provider?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface EndOptions {
  readonly measurements?: Partial<OperationMeasurements>;
  readonly effectState?: EffectState;
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly summary?: string;
}

export class Tracer {
  readonly sink: EventSink;
  readonly redactor: Redactor;
  private readonly clock: () => Date;

  constructor(options: TracerOptions = {}) {
    this.sink = options.sink ?? new InMemoryEventSink();
    this.redactor = options.redactor ?? new Redactor();
    this.clock = options.clock ?? (() => new Date());
  }

  emit(input: RuntimeEventInput, payloadSensitivity: Sensitivity = "internal"): RuntimeEvent {
    const captured = input.payload === undefined
      ? undefined
      : this.redactor.capture(input.payload, payloadSensitivity);
    const { payload: _payload, ...inputWithoutPayload } = input;
    const metadata = input.metadata === undefined
      ? undefined
      : this.redactor.sanitizeMetadata(input.metadata);
    const event = createRuntimeEvent({
      ...inputWithoutPayload,
      timestamp: input.timestamp ?? this.clock().toISOString(),
      ...(input.summary === undefined ? {} : { summary: sanitizeDurableText(input.summary) }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(captured?.captured === true ? { payload: captured.value } : {}),
    });
    this.sink.append(event);
    return event;
  }

  startRun(options: RunStartOptions = {}): RunTrace {
    const traceId = options.traceId ?? createTraceId();
    const runId = options.runId ?? createRunId();
    const spanId = createSpanId();
    const identity: IdentityOptions = {
      traceId,
      runId,
      actor: options.actor ?? "runtime",
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
    };
    const startedAt = this.clock();
    this.emit({
      traceId,
      runId,
      spanId,
      type: "run.started",
      actor: identity.actor,
      ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }),
      ...(identity.projectId === undefined ? {} : { projectId: identity.projectId }),
      ...(identity.deviceId === undefined ? {} : { deviceId: identity.deviceId }),
      timestamp: startedAt.toISOString(),
      status: "running",
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
    return new RunTrace(this, identity, spanId, startedAt.getTime());
  }

  startOperation(options: OperationStartOptions): OperationSpan {
    const spanId = createSpanId();
    const startedAt = this.clock();
    this.emit({
      traceId: options.traceId,
      runId: options.runId,
      spanId,
      ...(options.parentSpanId === undefined ? {} : { parentSpanId: options.parentSpanId }),
      type: "operation.started",
      actor: options.actor,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      operation: options.operation,
      timestamp: startedAt.toISOString(),
      status: "running",
      effectClass: options.effectClass,
      effectState: options.effectState ?? "none",
      ...(options.policyDecision === undefined ? {} : { policyDecision: options.policyDecision }),
      ...(options.policyEvidence === undefined ? {} : { policyEvidence: options.policyEvidence }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      ...(options.executor === undefined ? {} : { executor: options.executor }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
    return new OperationSpan(this, options, spanId, startedAt.getTime());
  }

  now(): Date {
    return this.clock();
  }
}

export class RunTrace {
  private readonly tracer: Tracer;
  private readonly identity: IdentityOptions;
  readonly spanId: SpanId;
  private readonly startedAtMs: number;
  private endEvent: RuntimeEvent | undefined;

  constructor(
    tracer: Tracer,
    identity: IdentityOptions,
    spanId: SpanId,
    startedAtMs: number,
  ) {
    this.tracer = tracer;
    this.identity = identity;
    this.spanId = spanId;
    this.startedAtMs = startedAtMs;
  }

  get traceId(): TraceId { return this.identity.traceId; }
  get runId(): RunId { return this.identity.runId; }
  get taskId(): TaskId | undefined { return this.identity.taskId; }

  operation(options: Omit<OperationStartOptions, "traceId" | "runId" | "actor" | "parentSpanId" | "taskId" | "projectId" | "deviceId">): OperationSpan {
    return this.tracer.startOperation({
      ...options,
      traceId: this.identity.traceId,
      runId: this.identity.runId,
      actor: this.identity.actor,
      parentSpanId: this.spanId,
      ...(this.identity.taskId === undefined ? {} : { taskId: this.identity.taskId }),
      ...(this.identity.projectId === undefined ? {} : { projectId: this.identity.projectId }),
      ...(this.identity.deviceId === undefined ? {} : { deviceId: this.identity.deviceId }),
    });
  }

  complete(metadata?: Readonly<Record<string, unknown>>): RuntimeEvent {
    if (this.endEvent !== undefined) return this.endEvent;
    const endedAt = this.tracer.now();
    this.endEvent = this.tracer.emit({
      traceId: this.identity.traceId,
      runId: this.identity.runId,
      spanId: this.spanId,
      type: "run.completed",
      actor: this.identity.actor,
      ...(this.identity.taskId === undefined ? {} : { taskId: this.identity.taskId }),
      ...(this.identity.projectId === undefined ? {} : { projectId: this.identity.projectId }),
      ...(this.identity.deviceId === undefined ? {} : { deviceId: this.identity.deviceId }),
      status: "completed",
      timestamp: endedAt.toISOString(),
      measurements: { durationMs: Math.max(0, endedAt.getTime() - this.startedAtMs) },
      ...(metadata === undefined ? {} : { metadata }),
    });
    return this.endEvent;
  }

  fail(error: RuntimeError, metadata?: Readonly<Record<string, unknown>>): RuntimeEvent {
    if (error.effect === "unknown") return this.unknown(error, metadata);
    if (this.endEvent !== undefined) return this.endEvent;
    const endedAt = this.tracer.now();
    this.endEvent = this.tracer.emit({
      traceId: this.identity.traceId,
      runId: this.identity.runId,
      spanId: this.spanId,
      type: "run.failed",
      actor: this.identity.actor,
      ...(this.identity.taskId === undefined ? {} : { taskId: this.identity.taskId }),
      ...(this.identity.projectId === undefined ? {} : { projectId: this.identity.projectId }),
      ...(this.identity.deviceId === undefined ? {} : { deviceId: this.identity.deviceId }),
      status: "failed",
      effectState: error.effect,
      errorCode: error.code,
      timestamp: endedAt.toISOString(),
      measurements: { durationMs: Math.max(0, endedAt.getTime() - this.startedAtMs) },
      ...(metadata === undefined ? {} : { metadata }),
    });
    return this.endEvent;
  }

  cancel(error: RuntimeError, metadata?: Readonly<Record<string, unknown>>): RuntimeEvent {
    return this.finish("run.cancelled", "cancelled", error, metadata);
  }

  unknown(error: RuntimeError, metadata?: Readonly<Record<string, unknown>>): RuntimeEvent {
    return this.finish("run.unknown", "unknown", error, metadata);
  }

  private finish(
    type: "run.cancelled" | "run.unknown",
    status: "cancelled" | "unknown",
    error: RuntimeError,
    metadata?: Readonly<Record<string, unknown>>,
  ): RuntimeEvent {
    if (this.endEvent !== undefined) return this.endEvent;
    const endedAt = this.tracer.now();
    this.endEvent = this.tracer.emit({
      traceId: this.identity.traceId,
      runId: this.identity.runId,
      spanId: this.spanId,
      type,
      actor: this.identity.actor,
      ...(this.identity.taskId === undefined ? {} : { taskId: this.identity.taskId }),
      ...(this.identity.projectId === undefined ? {} : { projectId: this.identity.projectId }),
      ...(this.identity.deviceId === undefined ? {} : { deviceId: this.identity.deviceId }),
      status,
      effectState: status === "unknown" ? "unknown" : error.effect,
      errorCode: error.code,
      timestamp: endedAt.toISOString(),
      measurements: { durationMs: Math.max(0, endedAt.getTime() - this.startedAtMs) },
      ...(metadata === undefined ? {} : { metadata }),
    });
    return this.endEvent;
  }
}

export class OperationSpan {
  private readonly tracer: Tracer;
  private readonly options: OperationStartOptions;
  readonly spanId: SpanId;
  private readonly startedAtMs: number;
  readonly metrics = new MetricsAccumulator();
  private ended = false;
  private endEvent: RuntimeEvent | undefined;

  constructor(
    tracer: Tracer,
    options: OperationStartOptions,
    spanId: SpanId,
    startedAtMs: number,
  ) {
    this.tracer = tracer;
    this.options = options;
    this.spanId = spanId;
    this.startedAtMs = startedAtMs;
  }

  get traceId(): TraceId { return this.options.traceId; }
  get runId(): RunId { return this.options.runId; }
  get parentSpanId(): SpanId | undefined { return this.options.parentSpanId; }
  get operation(): string { return this.options.operation; }
  get startedAt(): string { return new Date(this.startedAtMs).toISOString(); }

  record(measurements: Partial<OperationMeasurements>): this {
    if (this.ended) throw new Error("Cannot record measurements after a span has ended");
    this.metrics.record(measurements);
    return this;
  }

  complete(options: EndOptions = {}): RuntimeEvent {
    return this.finish("operation.completed", "completed", options);
  }

  fail(error: RuntimeError, options: EndOptions = {}): RuntimeEvent {
    return this.finish("operation.failed", "failed", {
      ...options,
      effectState: options.effectState ?? error.effect,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    }, error.code);
  }

  cancel(options: EndOptions = {}): RuntimeEvent {
    return this.finish("operation.cancelled", "cancelled", options, "OPERATION_CANCELLED");
  }

  unknown(error: RuntimeError, options: EndOptions = {}): RuntimeEvent {
    return this.finish("operation.unknown", "unknown", {
      ...options,
      effectState: options.effectState ?? error.effect,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    }, error.code);
  }

  private finish(
    type: "operation.completed" | "operation.failed" | "operation.cancelled" | "operation.unknown",
    status: "completed" | "failed" | "cancelled" | "unknown",
    options: EndOptions,
    errorCode?: string,
  ): RuntimeEvent {
    if (this.endEvent !== undefined) return this.endEvent;
    this.ended = true;
    if (options.measurements !== undefined) this.metrics.record(options.measurements);
    const endedAt = this.tracer.now();
    this.metrics.setDuration(Math.max(0, endedAt.getTime() - this.startedAtMs));
    const measurements = this.metrics.snapshot();
    this.endEvent = this.tracer.emit({
      traceId: this.options.traceId,
      runId: this.options.runId,
      spanId: this.spanId,
      ...(this.options.parentSpanId === undefined ? {} : { parentSpanId: this.options.parentSpanId }),
      type,
      actor: this.options.actor,
      ...(this.options.taskId === undefined ? {} : { taskId: this.options.taskId }),
      ...(this.options.projectId === undefined ? {} : { projectId: this.options.projectId }),
      ...(this.options.deviceId === undefined ? {} : { deviceId: this.options.deviceId }),
      operation: this.options.operation,
      status,
      timestamp: endedAt.toISOString(),
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      measurements,
      effectClass: this.options.effectClass,
      effectState: options.effectState ?? this.options.effectState ?? "none",
      ...(this.options.policyDecision === undefined ? {} : { policyDecision: this.options.policyDecision }),
      ...(this.options.policyEvidence === undefined ? {} : { policyEvidence: this.options.policyEvidence }),
      ...(this.options.idempotencyKey === undefined ? {} : { idempotencyKey: this.options.idempotencyKey }),
      ...(this.options.executor === undefined ? {} : { executor: this.options.executor }),
      ...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
      ...(options.artifactRefs === undefined ? {} : { artifactRefs: options.artifactRefs }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
    return this.endEvent;
  }
}
