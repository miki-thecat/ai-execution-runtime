import type { Capabilities } from "./capabilities.ts";
import { fullAlphaDefaultPolicy, type EffectPolicy } from "./effects.ts";
import { resolveRuntimeBudgets, type RuntimeBudgets, type RuntimeBudgetOverrides } from "../policy/budgets.ts";
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
  readonly budgets: RuntimeBudgets;
  readonly idempotencyKey?: string;
  readonly capabilities: Capabilities;
  /** The span belonging to the current operation, when instrumentation has started. */
  readonly spanId?: SpanId;
  /** The span that caused the current operation to be invoked. */
  readonly parentSpanId?: SpanId;
}

export interface OperationContextInit extends Omit<OperationContext, "actor" | "signal" | "effectPolicy" | "capabilities" | "budgets" | "deadline"> {
  readonly actor?: Actor;
  readonly signal?: AbortSignal;
  readonly effectPolicy?: EffectPolicy;
  readonly capabilities?: Capabilities;
  readonly budgets?: RuntimeBudgetOverrides;
  readonly deadline?: number;
}

export function createOperationContext(init: OperationContextInit): OperationContext {
  const budgets = resolveRuntimeBudgets(init.budgets);
  const budgetDeadline = Date.now() + budgets.maxExecutionMs;
  if (init.deadline !== undefined && Number.isNaN(init.deadline)) {
    throw new RangeError("deadline must not be NaN");
  }
  // Infinity means that the caller did not add a narrower deadline. It must
  // still be clamped to the runtime-owned execution ceiling.
  const deadline = init.deadline === undefined || init.deadline === Number.POSITIVE_INFINITY
    ? budgetDeadline
    : Math.min(init.deadline, budgetDeadline);
  return {
    traceId: init.traceId,
    runId: init.runId,
    ...(init.taskId === undefined ? {} : { taskId: init.taskId }),
    ...(init.projectId === undefined ? {} : { projectId: init.projectId }),
    ...(init.deviceId === undefined ? {} : { deviceId: init.deviceId }),
    actor: init.actor ?? "runtime",
    deadline,
    signal: init.signal ?? new AbortController().signal,
    effectPolicy: init.effectPolicy ?? fullAlphaDefaultPolicy(),
    budgets,
    ...(init.idempotencyKey === undefined ? {} : { idempotencyKey: init.idempotencyKey }),
    capabilities: init.capabilities ?? {},
    ...(init.spanId === undefined ? {} : { spanId: init.spanId }),
    ...(init.parentSpanId === undefined ? {} : { parentSpanId: init.parentSpanId }),
  };
}

export function isDeadlineExceeded(context: OperationContext, now = Date.now()): boolean {
  if (context.deadline === undefined) return false;
  // A forged non-finite context must fail closed. createOperationContext
  // rejects NaN and clamps positive infinity, but this also protects callers
  // constructing an OperationContext at an adapter boundary.
  if (!Number.isFinite(context.deadline)) return context.deadline !== Number.POSITIVE_INFINITY;
  return now >= context.deadline;
}
