import type { Actor } from "../core/context.ts";
import type { EffectClass } from "../core/effects.ts";
import type {
  DeviceId,
  ProjectId,
  RunId,
  SpanId,
  TaskId,
  TraceId,
} from "../core/ids.ts";
import { createRunId, createTraceId } from "../core/ids.ts";
import type { RuntimeBudgetOverrides } from "../policy/budgets.ts";

/** Correlation identifiers are transport values, not a second runtime state model. */
export type RequestId = string & { readonly __brand: "RequestId" };

/** Compatibility names for adapters that call the same boundary a request or operation envelope. */
export type SemanticOperationRequest<Input = unknown> = SemanticOperationEnvelope<Input>;
export type OperationEnvelope<Input = unknown> = SemanticOperationEnvelope<Input>;

export function createRequestId(): RequestId {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `request_${uuid}` as RequestId;
}

export type DevicePresence = "online" | "offline";

/** A device advertises what it can do; projects and tasks remain AER-owned state. */
export interface DeviceCapabilities {
  readonly operations?: readonly string[];
  readonly features?: Readonly<Record<string, boolean>>;
  readonly runtime?: Readonly<Record<string, string>>;
}

export interface DeviceIdentity {
  readonly deviceId: DeviceId;
  readonly name: string;
  readonly capabilities: DeviceCapabilities;
  readonly presence: DevicePresence;
  readonly connectedAt?: string;
  readonly lastSeenAt: string;
}

export interface SemanticOperationTarget {
  readonly deviceId?: DeviceId;
  readonly projectId?: ProjectId;
}

export interface CallerAuthority {
  readonly principal?: string;
  readonly authorityScope?: readonly string[];
}

/**
 * Provider-neutral semantic operation boundary. `effectClass` is an asserted
 * client value only; the daemon always resolves the registered operation's
 * effect class before execution.
 */
export interface SemanticOperationEnvelope<Input = unknown> extends CallerAuthority {
  readonly protocol: "aer.semantic-operation.v1";
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly spanId?: SpanId;
  readonly target?: SemanticOperationTarget;
  /** Aliases are accepted for thin adapters that flatten the target. */
  readonly deviceId?: DeviceId;
  readonly projectId?: ProjectId;
  readonly operation: string;
  readonly input?: Input;
  readonly validatedInput?: Input;
  readonly deadline?: number;
  readonly serverDeadline?: number;
  readonly budgets?: RuntimeBudgetOverrides;
  readonly effectClass?: EffectClass;
  readonly assertedEffectClass?: EffectClass;
  readonly idempotencyKey?: string;
  readonly idempotency?: { readonly key: string };
  readonly caller?: CallerAuthority;
  readonly actor?: Actor;
}

export interface SemanticOperationEnvelopeInit<Input = unknown> extends Partial<CallerAuthority> {
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly runId?: RunId;
  readonly taskId?: TaskId;
  readonly spanId?: SpanId;
  readonly target?: SemanticOperationTarget;
  readonly deviceId?: DeviceId;
  readonly projectId?: ProjectId;
  readonly operation: string;
  readonly input?: Input;
  readonly validatedInput?: Input;
  readonly deadline?: number;
  readonly serverDeadline?: number;
  readonly budgets?: RuntimeBudgetOverrides;
  readonly effectClass?: EffectClass;
  readonly assertedEffectClass?: EffectClass;
  readonly idempotencyKey?: string;
  readonly idempotency?: { readonly key: string };
  readonly caller?: CallerAuthority;
  readonly actor?: Actor;
}

export function createSemanticOperationEnvelope<Input>(
  init: SemanticOperationEnvelopeInit<Input>,
): SemanticOperationEnvelope<Input> {
  const input = init.input === undefined ? init.validatedInput : init.input;
  return {
    protocol: "aer.semantic-operation.v1",
    requestId: init.requestId ?? createRequestId(),
    traceId: init.traceId ?? createTraceId(),
    runId: init.runId ?? createRunId(),
    ...(init.taskId === undefined ? {} : { taskId: init.taskId }),
    ...(init.spanId === undefined ? {} : { spanId: init.spanId }),
    ...(init.target === undefined ? {} : { target: init.target }),
    ...(init.deviceId === undefined ? {} : { deviceId: init.deviceId }),
    ...(init.projectId === undefined ? {} : { projectId: init.projectId }),
    operation: init.operation,
    ...(input === undefined ? {} : { input }),
    ...(init.deadline === undefined ? {} : { deadline: init.deadline }),
    ...(init.serverDeadline === undefined ? {} : { serverDeadline: init.serverDeadline }),
    ...(init.budgets === undefined ? {} : { budgets: init.budgets }),
    ...(init.effectClass === undefined ? {} : { effectClass: init.effectClass }),
    ...(init.assertedEffectClass === undefined ? {} : { assertedEffectClass: init.assertedEffectClass }),
    ...(init.idempotencyKey === undefined ? {} : { idempotencyKey: init.idempotencyKey }),
    ...(init.idempotency === undefined ? {} : { idempotency: init.idempotency }),
    ...(init.principal === undefined ? {} : { principal: init.principal }),
    ...(init.authorityScope === undefined ? {} : { authorityScope: init.authorityScope }),
    ...(init.caller === undefined ? {} : { caller: init.caller }),
    ...(init.actor === undefined ? {} : { actor: init.actor }),
  };
}

export type LocalControlRequest<Input = unknown> =
  | { readonly type: "ping" }
  | { readonly type: "execute"; readonly envelope: SemanticOperationEnvelope<Input> };

export interface LocalControlResponse<T = unknown> {
  readonly type: "pong" | "response" | "error";
  readonly value?: T;
  readonly error?: { readonly code: string; readonly message: string };
}
