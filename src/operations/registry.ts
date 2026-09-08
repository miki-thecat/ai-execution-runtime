import { createOperationContext, type OperationContext } from "../core/context.ts";
import type { EffectClass } from "../core/effects.ts";
import {
  createOperationMeta,
  createRuntimeError,
  isRuntimeError,
  runtimeFailure,
  type OperationMeta,
  type RuntimeError,
  type RuntimeResult,
} from "../core/index.ts";
import { InMemoryEventSink, Tracer, type OperationSpan, type RuntimeEvent } from "../observability/index.ts";
import type { Operation } from "./operation.ts";

interface RegisteredOperation {
  readonly name: string;
  readonly effectClass: EffectClass;
  readonly executor?: string;
  readonly provider?: string;
  readonly execute: Operation<unknown, unknown>["execute"];
}

type EventMeasurements = Pick<RuntimeEvent,
  | "durationMs"
  | "internalCalls"
  | "retries"
  | "pollCountInternal"
  | "pollCountModel"
  | "inputBytes"
  | "rawOutputBytes"
  | "returnedOutputBytes"
  | "artifactBytes"
  | "filesRead"
  | "filesChanged"
  | "exitCode"
  | "signal"
  | "tokenInput"
  | "tokenOutput"
  | "tokenCached"
  | "compressionRatio"
>;

export interface OperationRegistryOptions {
  readonly tracer?: Tracer;
}

export class OperationRegistry {
  readonly tracer: Tracer;
  readonly eventSink: InMemoryEventSink | undefined;
  private readonly operations = new Map<string, RegisteredOperation>();

  constructor(options: OperationRegistryOptions = {}) {
    if (options.tracer !== undefined) {
      this.tracer = options.tracer;
    } else {
      const eventSink = new InMemoryEventSink();
      this.eventSink = eventSink;
      this.tracer = new Tracer({ sink: eventSink });
    }
  }

  register<Input, Output>(operation: Operation<Input, Output>): this {
    if (operation.name.trim() === "") throw new Error("Operation name cannot be empty");
    if (this.operations.has(operation.name)) {
      throw new Error(`Operation already registered: ${operation.name}`);
    }
    this.operations.set(operation.name, operation as unknown as RegisteredOperation);
    return this;
  }

  unregister(name: string): boolean {
    return this.operations.delete(name);
  }

  has(name: string): boolean {
    return this.operations.has(name);
  }

  names(): readonly string[] {
    return [...this.operations.keys()].sort();
  }

  get<Input, Output>(name: string): Operation<Input, Output> | undefined {
    return this.operations.get(name) as Operation<Input, Output> | undefined;
  }

  async execute<Input, Output>(
    name: string,
    input: Input,
    context: OperationContext,
  ): Promise<RuntimeResult<Output>> {
    const registered = this.operations.get(name);
    const effectClass = registered?.effectClass ?? "none";
    const parentSpanId = context.spanId ?? context.parentSpanId;
    const startOptions = {
      traceId: context.traceId,
      runId: context.runId,
      actor: context.actor,
      operation: name,
      effectClass,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
      ...(registered?.executor === undefined ? {} : { executor: registered.executor }),
      ...(registered?.provider === undefined ? {} : { provider: registered.provider }),
    };
    const span = this.tracer.startOperation(startOptions);
    const operationContext = createOperationContext({
      ...context,
      spanId: span.spanId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
    });

    if (registered === undefined) {
      const error = createRuntimeError({
        code: "OPERATION_NOT_FOUND",
        message: `Operation is not registered: ${name}`,
        retryable: false,
        effect: "none",
      });
      const event = span.fail(error);
      return runtimeFailure(error, createOperationMeta({
        context: operationContext,
        operation: name,
        status: "failed",
        effectClass: "none",
        effectState: "none",
        startedAt: span.startedAt,
        completedAt: event.timestamp,
        metrics: eventMeasurements(event),
      }));
    }

    try {
      const result = await registered.execute(input, operationContext);
      span.record(result.meta.metrics);
      if (result.ok) {
        const event = span.complete({
          effectState: result.meta.effectState,
          artifactRefs: result.meta.artifactRefs,
          summary: result.meta.summary,
        });
        return {
          ok: true,
          data: result.data,
          meta: normalizedMeta(result.meta, operationContext, registered, "completed", span, event),
        };
      }

      const event = span.fail(result.error, {
        effectState: result.error.effect,
        artifactRefs: result.meta.artifactRefs,
        summary: result.meta.summary,
      });
      return {
        ok: false,
        error: result.error,
        meta: normalizedMeta(result.meta, operationContext, registered, "failed", span, event),
      };
    } catch (cause: unknown) {
      const error: RuntimeError = isRuntimeError(cause)
        ? cause
        : createRuntimeError({
            code: "OPERATION_THROWN",
            message: cause instanceof Error ? cause.message : "Operation threw a non-error value",
            retryable: false,
            effect: "unknown",
          });
      const event = span.fail(error);
      return runtimeFailure(error, createOperationMeta({
        context: operationContext,
        operation: name,
        status: "failed",
        effectClass: registered.effectClass,
        effectState: error.effect,
        startedAt: span.startedAt,
        completedAt: event.timestamp,
        metrics: eventMeasurements(event),
        executor: registered.executor,
        provider: registered.provider,
      }));
    }
  }
}

function eventMeasurements(event: EventMeasurements): OperationMeta["metrics"] {
  return {
    durationMs: event.durationMs,
    internalCalls: event.internalCalls,
    retries: event.retries,
    pollCountInternal: event.pollCountInternal,
    pollCountModel: event.pollCountModel,
    inputBytes: event.inputBytes,
    rawOutputBytes: event.rawOutputBytes,
    returnedOutputBytes: event.returnedOutputBytes,
    artifactBytes: event.artifactBytes,
    filesRead: event.filesRead,
    filesChanged: event.filesChanged,
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.signal === undefined ? {} : { signal: event.signal }),
    ...(event.tokenInput === undefined ? {} : { tokenInput: event.tokenInput }),
    ...(event.tokenOutput === undefined ? {} : { tokenOutput: event.tokenOutput }),
    ...(event.tokenCached === undefined ? {} : { tokenCached: event.tokenCached }),
    compressionRatio: event.compressionRatio,
  };
}

function normalizedMeta(
  original: OperationMeta,
  context: OperationContext,
  operation: RegisteredOperation,
  status: "completed" | "failed",
  span: OperationSpan,
  event: RuntimeEvent,
): OperationMeta {
  return createOperationMeta({
    context,
    operation: operation.name,
    status,
    effectClass: operation.effectClass,
    effectState: event.effectState ?? original.effectState,
    startedAt: span.startedAt,
    completedAt: event.timestamp,
    metrics: eventMeasurements(event),
    artifactRefs: original.artifactRefs,
    summary: original.summary,
    truncated: original.truncated,
    executor: operation.executor,
    provider: operation.provider,
    verificationId: original.verificationId,
  });
}
