import type { Capabilities } from "./capabilities.ts";
import { permissiveEffectPolicy, type EffectPolicy } from "./effects.ts";
import type {
  DeviceId,
  ProjectId,
  RunId,
  SpanId,
  TaskId,
  TraceId,
} from "./ids.ts";

export type Actor = "user" | "model" | "runtime" | "provider" | "system" | (string & {});

export interface OperationContext {
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly projectId?: ProjectId;
  readonly deviceId?: DeviceId;
  readonly actor: Actor;
  readonly deadline?: number;
  readonly signal: AbortSignal;
  readonly effectPolicy: EffectPolicy;
  readonly idempotencyKey?: string;
  readonly capabilities: Capabilities;
  /** The span belonging to the current operation, when instrumentation has started. */
  readonly spanId?: SpanId;
  /** The span that caused the current operation to be invoked. */
  readonly parentSpanId?: SpanId;
}

export interface OperationContextInit extends Omit<OperationContext, "actor" | "signal" | "effectPolicy" | "capabilities"> {
  readonly actor?: Actor;
  readonly signal?: AbortSignal;
  readonly effectPolicy?: EffectPolicy;
  readonly capabilities?: Capabilities;
}

export function createOperationContext(init: OperationContextInit): OperationContext {
  return {
    traceId: init.traceId,
    runId: init.runId,
    ...(init.taskId === undefined ? {} : { taskId: init.taskId }),
    ...(init.projectId === undefined ? {} : { projectId: init.projectId }),
    ...(init.deviceId === undefined ? {} : { deviceId: init.deviceId }),
    actor: init.actor ?? "runtime",
    ...(init.deadline === undefined ? {} : { deadline: init.deadline }),
    signal: init.signal ?? new AbortController().signal,
    effectPolicy: init.effectPolicy ?? permissiveEffectPolicy(),
    ...(init.idempotencyKey === undefined ? {} : { idempotencyKey: init.idempotencyKey }),
    capabilities: init.capabilities ?? {},
    ...(init.spanId === undefined ? {} : { spanId: init.spanId }),
    ...(init.parentSpanId === undefined ? {} : { parentSpanId: init.parentSpanId }),
  };
}

export function isDeadlineExceeded(context: OperationContext, now = Date.now()): boolean {
  return context.deadline !== undefined && now >= context.deadline;
}
