import { createOperationContext, type OperationContext } from "../core/context.ts";
import { EFFECT_CLASSES, policyDecisionEvidence, type EffectClass, type EffectPolicy } from "../core/effects.ts";
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
  /** Runtime policy is authoritative over provider-local policy hints. */
  readonly policy?: EffectPolicy;
}

export class OperationRegistry {
  readonly tracer: Tracer;
  readonly eventSink: InMemoryEventSink | undefined;
  private readonly policy: EffectPolicy | undefined;
  private readonly operations = new Map<string, RegisteredOperation>();

  constructor(options: OperationRegistryOptions = {}) {
    if (options.tracer !== undefined) {
      this.tracer = options.tracer;
    } else {
      const eventSink = new InMemoryEventSink();
      this.eventSink = eventSink;
      this.tracer = new Tracer({ sink: eventSink });
    }
    this.policy = options.policy;
  }

  register<Input, Output>(operation: Operation<Input, Output>): this {
    if (operation.name.trim() === "") throw new Error("Operation name cannot be empty");
    if (!EFFECT_CLASSES.includes(operation.effectClass)) throw new Error(`Operation ${operation.name} must declare a canonical effect class`);
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
    const effectClass = registered?.effectClass ?? "read";
    const effectivePolicy = this.policy ?? context.effectPolicy;
    const policyEvidence = policyDecisionEvidence(effectivePolicy, effectClass);
    const policyDecision = policyEvidence.decision;
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
      policyDecision,
      policyEvidence,
      metadata: { policy: policyEvidence },
    };
    const span = this.tracer.startOperation(startOptions);
    const operationContext = createOperationContext({
      ...context,
      effectPolicy: effectivePolicy,
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
        effectClass: "read",
        effectState: "none",
        startedAt: span.startedAt,
        completedAt: event.timestamp,
        metrics: eventMeasurements(event),
        policyDecision,
        policyEvidence,
      }));
    }

    if (policyDecision !== "allow") {
      const error = createRuntimeError({
        code: policyDecision === "approval_required" ? "EFFECT_APPROVAL_REQUIRED" : "EFFECT_NOT_ALLOWED",
        message: policyEvidence.reason,
        retryable: false,
        effect: "none",
        details: { effectClass, policy: policyEvidence.policy, decision: policyDecision },
      });
      const event = span.fail(error, { summary: policyEvidence.reason });
      return runtimeFailure(error, createOperationMeta({
        context: operationContext,
        operation: name,
        status: "failed",
        effectClass,
        effectState: "none",
        startedAt: span.startedAt,
        completedAt: event.timestamp,
        metrics: eventMeasurements(event),
        policyDecision,
        policyEvidence,
      }));
    }

    const inputSize = new TextEncoder().encode(JSON.stringify(input) ?? String(input)).byteLength;
    if (inputSize > operationContext.budgets.maxInputBytes) {
      const error = createRuntimeError({ code: "OPERATION_INPUT_TOO_LARGE", message: "Operation input exceeds the runtime budget", retryable: false, effect: "none", details: { inputBytes: inputSize, maxInputBytes: operationContext.budgets.maxInputBytes } });
      const event = span.fail(error, { summary: error.message });
      return runtimeFailure(error, createOperationMeta({ context: operationContext, operation: name, status: "failed", effectClass, effectState: "none", startedAt: span.startedAt, completedAt: event.timestamp, metrics: { inputBytes: inputSize }, policyDecision, policyEvidence }));
    }

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (operationContext.signal.aborted) controller.abort();
    else operationContext.signal.addEventListener("abort", forwardAbort, { once: true });
    const executionContext = createOperationContext({ ...operationContext, signal: controller.signal });
    try {
      const result = await executeWithinDeadline(() => registered.execute(input, executionContext) as RuntimeResult<Output> | Promise<RuntimeResult<Output>>, executionContext, controller);
      span.record(result.meta.metrics);
      if (result.ok) {
        const event = span.complete({
          effectState: result.meta.effectState,
          artifactRefs: result.meta.artifactRefs,
          ...(result.meta.summary === undefined ? {} : { summary: result.meta.summary }),
        });
        return {
          ok: true,
          data: result.data,
          meta: normalizedMeta(result.meta, executionContext, registered, result.meta.status, span, event, policyEvidence),
        };
      }

      const status = result.error.effect === "unknown" ? "unknown" : result.meta.status;
      const event = finishFailure(span, result.error, result.meta, status);
      return {
        ok: false,
        error: result.error,
        meta: normalizedMeta(result.meta, executionContext, registered, status, span, event, policyEvidence),
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
      const unknown = error.effect === "unknown";
      const event = unknown ? span.unknown(error) : span.fail(error);
      return runtimeFailure(error, createOperationMeta({
        context: executionContext,
        operation: name,
        status: unknown ? "unknown" : "failed",
        effectClass: registered.effectClass,
        effectState: error.effect,
        startedAt: span.startedAt,
        completedAt: event.timestamp,
        metrics: eventMeasurements(event),
        ...(registered.executor === undefined ? {} : { executor: registered.executor }),
        ...(registered.provider === undefined ? {} : { provider: registered.provider }),
        policyDecision,
        policyEvidence,
      }));
    } finally {
      operationContext.signal.removeEventListener("abort", forwardAbort);
    }
  }
}

async function executeWithinDeadline<T>(work: () => T | Promise<T>, context: OperationContext, controller: AbortController): Promise<T> {
  // OperationContext normally contains a finite, already-clamped deadline.
  // Keep the dispatcher fail-closed for adapters that provide a structurally
  // valid but non-finite context, so NaN/infinity cannot disable the runtime
  // execution ceiling.
  const deadline = context.deadline === undefined
    ? Date.now() + context.budgets.maxExecutionMs
    : Number.isFinite(context.deadline)
      ? context.deadline
      : context.deadline === Number.POSITIVE_INFINITY
        ? Date.now() + context.budgets.maxExecutionMs
        : Date.now();
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    throw createRuntimeError({ code: "OPERATION_DEADLINE_EXCEEDED", message: "Operation exceeded the runtime execution budget", retryable: true, effect: "unknown" });
  }
  const operation = work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(createRuntimeError({ code: "OPERATION_DEADLINE_EXCEEDED", message: "Operation exceeded the runtime execution budget", retryable: true, effect: "unknown" }));
    }, remaining);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
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
  status: OperationMeta["status"],
  span: OperationSpan,
  event: RuntimeEvent,
  policyEvidence: ReturnType<typeof policyDecisionEvidence>,
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
    ...(original.summary === undefined ? {} : { summary: original.summary }),
    truncated: original.truncated,
    ...(operation.executor === undefined ? {} : { executor: operation.executor }),
    ...(operation.provider === undefined ? {} : { provider: operation.provider }),
    policyDecision: policyEvidence.decision,
    policyEvidence,
    ...(original.verificationId === undefined ? {} : { verificationId: original.verificationId }),
  });
}

function finishFailure(
  span: OperationSpan,
  error: RuntimeError,
  meta: OperationMeta,
  status: OperationMeta["status"],
): RuntimeEvent {
  const options = {
    effectState: error.effect,
    artifactRefs: meta.artifactRefs,
    ...(meta.summary === undefined ? {} : { summary: meta.summary }),
  };

  switch (status) {
    case "cancelled":
      return span.cancel(options);
    case "unknown":
      return span.unknown(error, options);
    case "failed":
    case "completed":
      return span.fail(error, options);
  }
}
