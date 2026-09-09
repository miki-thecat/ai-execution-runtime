import { FileArtifactStore } from "../artifacts/store.ts";
import { createOperationContext, isDeadlineExceeded, type OperationContext } from "../core/context.ts";
import { isEffectAllowed, policyDecisionEvidence, requiresApproval, type EffectClass } from "../core/effects.ts";
import {
  createOperationMeta,
  createRuntimeError,
  runtimeFailure,
  runtimeSuccess,
  type RuntimeResult,
} from "../core/result.ts";
import type { Operation } from "../operations/operation.ts";
import { Tracer } from "../observability/tracer.ts";
import { DirectProcessManager } from "./process.ts";
import type {
  DirectExecutionOptions,
  DirectRunOptions,
  ExecutableCommand,
  ExecutableRunResult,
  ProcessHandle,
  ProcessResult,
  ShellRunInput,
  ShellRunResult,
} from "./types.ts";

const DIRECT_EFFECT_CLASS = "destructive" as const;

function inputBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value, (_key, item) => {
    if (_key.toLowerCase().includes("env")) return Object.keys(item ?? {}).sort();
    return item;
  })).byteLength;
}

function failureMeta(
  context: OperationContext,
  operation: string,
  status: "failed" | "cancelled" | "unknown",
  startedAt: string,
  completedAt: string,
  error: ReturnType<typeof createRuntimeError>,
  metrics: ProcessResult | undefined,
  artifactRefs: readonly import("../core/ids.ts").ArtifactRef[] = [],
  commandInputBytes = 0,
  effectClass: EffectClass = DIRECT_EFFECT_CLASS,
  policyEvidence = policyDecisionEvidence(context.effectPolicy, effectClass),
) {
  return createOperationMeta({
    context,
    operation,
    status,
    effectClass,
    effectState: error.effect,
    startedAt,
    completedAt,
    artifactRefs,
    metrics: metrics === undefined ? {} : {
      internalCalls: 1,
      inputBytes: commandInputBytes,
      rawOutputBytes: metrics.rawOutputBytes,
      returnedOutputBytes: metrics.returnedOutputBytes,
      artifactBytes: metrics.artifactBytes,
      durationMs: metrics.durationMs,
      ...(metrics.exitCode === undefined ? {} : { exitCode: metrics.exitCode }),
      ...(metrics.signal === undefined ? {} : { signal: metrics.signal }),
    },
    truncated: metrics?.truncated ?? false,
    policyDecision: policyEvidence.decision,
    policyEvidence,
  });
}

export class DirectExecutor {
  readonly tracer: Tracer;
  readonly processes: DirectProcessManager;

  constructor(options: DirectExecutionOptions = {}) {
    this.tracer = options.tracer ?? new Tracer();
    this.processes = new DirectProcessManager({
      tracer: this.tracer,
      ...(options.state === undefined ? {} : { state: options.state }),
      artifacts: options.artifacts ?? new FileArtifactStore(),
      ...(options.defaultMaxOutputBytes === undefined ? {} : { defaultMaxOutputBytes: options.defaultMaxOutputBytes }),
      ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
      ...(options.reconcileOnStart === undefined ? {} : { reconcileOnStart: options.reconcileOnStart }),
      ...(options.credentialClassifiers === undefined ? {} : { credentialClassifiers: options.credentialClassifiers }),
    });
  }

  startExecutable(command: ExecutableCommand, context: OperationContext, options: Pick<DirectRunOptions, "effectClass"> = {}): ProcessHandle {
    const effectClass = options.effectClass ?? DIRECT_EFFECT_CLASS;
    this.assertAllowed(context, effectClass);
    const commandBytes = inputBytes({ executable: command.executable, args: command.args ?? [], cwd: command.cwd, env: command.env });
    if (commandBytes > context.budgets.maxInputBytes) throw createRuntimeError({ code: "PROCESS_INPUT_TOO_LARGE", message: "Direct command input exceeds the runtime budget", retryable: false, effect: "none", details: { inputBytes: commandBytes, maxInputBytes: context.budgets.maxInputBytes } });
    if (context.signal.aborted || isDeadlineExceeded(context)) {
      throw createRuntimeError({
        code: "PROCESS_CANCELLED_BEFORE_START",
        message: "The execution context was already cancelled or expired",
        retryable: false,
        effect: "none",
      });
    }
    return this.processes.start({
      command,
      operation: "process.run",
      context,
      effectClass,
    });
  }

  async runExecutable(
    command: ExecutableCommand,
    context: OperationContext,
    options: DirectRunOptions = {},
  ): Promise<RuntimeResult<ExecutableRunResult>> {
    return this.runInternal(
      "process.run",
      context,
      { ...command, args: [...(command.args ?? [])] },
      (runContext, effectClass) => this.processes.start({ command, operation: "process.run", context: runContext, effectClass }),
      (result) => ({ ...result, executable: command.executable, args: [...(command.args ?? [])] }),
      options.instrument !== false,
      inputBytes({ executable: command.executable, args: command.args ?? [], cwd: command.cwd, env: command.env }),
      options.effectClass ?? DIRECT_EFFECT_CLASS,
    );
  }

  /** Alias for internal providers that model the primitive as process.run. */
  runCommand(command: ExecutableCommand, context: OperationContext, options: DirectRunOptions = {}): Promise<RuntimeResult<ExecutableRunResult>> {
    return this.runExecutable(command, context, options);
  }

  /** Runtime-owned process lifecycle helpers; callers do not need to poll child processes. */
  start(command: ExecutableCommand, context: OperationContext, options: Pick<DirectRunOptions, "effectClass"> = {}): ProcessHandle {
    return this.startExecutable(command, context, options);
  }

  wait(handle: ProcessHandle): Promise<ProcessResult> {
    return handle.wait();
  }

  cancel(handle: ProcessHandle, reason: "cancel" | "timeout" = "cancel"): Promise<ProcessResult> {
    return handle.cancel(reason);
  }

  async runShell(
    input: ShellRunInput,
    context: OperationContext,
    options: DirectRunOptions = {},
  ): Promise<RuntimeResult<ShellRunResult>> {
    const command: ExecutableCommand = {
      executable: input.command,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.inheritEnvironment === undefined ? {} : { inheritEnvironment: input.inheritEnvironment }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    };
    return this.runInternal(
      "shell.run",
      context,
      command,
      (runContext, effectClass) => this.processes.start({ command, shell: true, operation: "shell.run", context: runContext, effectClass }),
      (result) => ({ ...result, command: input.command }),
      options.instrument !== false,
      inputBytes({ command: input.command, cwd: input.cwd, env: input.env }),
      options.effectClass ?? DIRECT_EFFECT_CLASS,
    );
  }

  reconcile(): readonly import("./types.ts").ProcessId[] {
    return this.processes.reconcile();
  }

  private async runInternal<T>(
    operation: string,
    context: OperationContext,
    command: ExecutableCommand,
    start: (context: OperationContext, effectClass: EffectClass) => ProcessHandle,
    map: (result: ProcessResult) => T,
    instrument: boolean,
    commandInputBytes: number,
    effectClass: EffectClass,
  ): Promise<RuntimeResult<T>> {
    const startedAt = this.tracer.now().toISOString();
    const policyEvidence = policyDecisionEvidence(context.effectPolicy, effectClass);
    const span = instrument ? this.tracer.startOperation({
      traceId: context.traceId,
      runId: context.runId,
      actor: context.actor,
      operation,
      effectClass,
      ...(context.spanId === undefined ? {} : { parentSpanId: context.spanId }),
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
      executor: "direct",
      provider: "node:child_process",
      policyDecision: policyEvidence.decision,
      policyEvidence,
      metadata: { executable: command.executable, argumentCount: command.args?.length ?? 0 },
    }) : undefined;
    const operationContext = span === undefined ? context : createOperationContext({
      ...context,
      spanId: span.spanId,
      ...(context.spanId === undefined ? {} : { parentSpanId: context.spanId }),
    });
    try {
      if (commandInputBytes > operationContext.budgets.maxInputBytes) {
        throw createRuntimeError({ code: "PROCESS_INPUT_TOO_LARGE", message: "Direct command input exceeds the runtime budget", retryable: false, effect: "none", details: { inputBytes: commandInputBytes, maxInputBytes: operationContext.budgets.maxInputBytes } });
      }
      this.assertAllowed(operationContext, effectClass);
      if (operationContext.signal.aborted || isDeadlineExceeded(operationContext)) {
        throw createRuntimeError({ code: "PROCESS_CANCELLED_BEFORE_START", message: "The execution context was already cancelled or expired", retryable: false, effect: "none" });
      }
      const handle = start(operationContext, effectClass);
      const processResult = await handle.wait();
      const result = map(processResult);
      const metrics = {
        internalCalls: 1,
        inputBytes: commandInputBytes,
        rawOutputBytes: processResult.rawOutputBytes,
        returnedOutputBytes: processResult.returnedOutputBytes,
        artifactBytes: processResult.artifactBytes,
        ...(processResult.exitCode === undefined ? {} : { exitCode: processResult.exitCode }),
        ...(processResult.signal === undefined ? {} : { signal: processResult.signal }),
      };
      if (span !== undefined) span.record(metrics);
      const completedAt = this.tracer.now().toISOString();
      if (processResult.cancelled) {
        const error = createRuntimeError({
          code: processResult.timedOut ? "PROCESS_TIMEOUT" : "PROCESS_CANCELLED",
          message: processResult.timedOut ? "Process exceeded its deadline" : "Process was cancelled",
          retryable: processResult.timedOut,
          effect: "unknown",
          details: { processId: processResult.processId },
        });
        const event = span?.cancel({ effectState: "unknown", artifactRefs: processResult.artifactRefs, summary: error.message });
        return runtimeFailure(error, failureMeta(
          operationContext,
          operation,
          "cancelled",
          span?.startedAt ?? startedAt,
          event?.timestamp ?? completedAt,
          error,
          processResult,
          processResult.artifactRefs,
          commandInputBytes,
          effectClass,
          policyEvidence,
        ));
      }
      if (processResult.status === "unknown") {
        const error = createRuntimeError({
          code: "PROCESS_EFFECT_UNKNOWN",
          message: processResult.error ?? "Direct process ended with an ambiguous effect",
          retryable: false,
          effect: "unknown",
          details: { processId: processResult.processId },
        });
        const event = span?.unknown(error, { artifactRefs: processResult.artifactRefs });
        return runtimeFailure(error, failureMeta(
          operationContext,
          operation,
          "unknown",
          span?.startedAt ?? startedAt,
          event?.timestamp ?? completedAt,
          error,
          processResult,
          processResult.artifactRefs,
          commandInputBytes,
          effectClass,
          policyEvidence,
        ));
      }
      if (processResult.status === "failed") {
        const error = createRuntimeError({
          code: "PROCESS_FAILED",
          message: processResult.error ?? "Direct process failed to execute",
          retryable: false,
          effect: "none",
          details: { processId: processResult.processId },
        });
        const event = span?.fail(error, { artifactRefs: processResult.artifactRefs });
        return runtimeFailure(error, failureMeta(
          operationContext,
          operation,
          "failed",
          span?.startedAt ?? startedAt,
          event?.timestamp ?? completedAt,
          error,
          processResult,
          processResult.artifactRefs,
          commandInputBytes,
          effectClass,
          policyEvidence,
        ));
      }
      const event = span?.complete({ artifactRefs: processResult.artifactRefs, effectState: processResult.effectState });
      return runtimeSuccess(result, createOperationMeta({
        context: operationContext,
        operation,
        status: "completed",
        effectClass,
        effectState: processResult.effectState,
        startedAt: span?.startedAt ?? startedAt,
        completedAt: event?.timestamp ?? completedAt,
        metrics: { ...metrics, durationMs: processResult.durationMs },
        artifactRefs: processResult.artifactRefs,
        truncated: processResult.truncated,
        executor: "direct",
        provider: "node:child_process",
        policyDecision: policyEvidence.decision,
        policyEvidence,
      }));
    } catch (cause: unknown) {
      const error = cause && typeof cause === "object" && "code" in cause
        ? cause as ReturnType<typeof createRuntimeError>
        : createRuntimeError({
            code: "PROCESS_START_FAILED",
            message: cause instanceof Error ? cause.message : "Direct process could not start",
            retryable: false,
            effect: "none",
          });
      const unknown = error.effect === "unknown";
      const event = unknown ? span?.unknown(error) : span?.fail(error);
      return runtimeFailure(error, failureMeta(
        operationContext,
        operation,
        unknown ? "unknown" : "failed",
        span?.startedAt ?? startedAt,
        event?.timestamp ?? this.tracer.now().toISOString(),
        error,
        undefined,
        [],
        commandInputBytes,
        effectClass,
        policyEvidence,
      ));
    }
  }

  private assertAllowed(context: OperationContext, effectClass: EffectClass): void {
    if (!isEffectAllowed(context.effectPolicy, effectClass)) {
      throw createRuntimeError({
        code: "EFFECT_NOT_ALLOWED",
        message: `The execution policy does not allow ${effectClass} direct shell/process execution`,
        retryable: false,
        effect: "none",
      });
    }
    if (requiresApproval(context.effectPolicy, effectClass)) {
      throw createRuntimeError({
        code: "EFFECT_APPROVAL_REQUIRED",
        message: `${effectClass} direct shell/process execution requires approval`,
        retryable: false,
        effect: "none",
      });
    }
  }
}

export function createShellRunOperation(executor: DirectExecutor): Operation<ShellRunInput, ShellRunResult> {
  return {
    name: "shell.run",
    effectClass: DIRECT_EFFECT_CLASS,
    executor: "direct",
    provider: "node:child_process",
    execute(input, context) {
      return executor.runShell(input, context, { instrument: false });
    },
  };
}

export function createExecutableRunOperation(executor: DirectExecutor): Operation<ExecutableCommand, ExecutableRunResult> {
  return {
    name: "process.run",
    effectClass: DIRECT_EFFECT_CLASS,
    executor: "direct",
    provider: "node:child_process",
    execute(input, context) {
      return executor.runExecutable(input, context, { instrument: false });
    },
  };
}

export const createProcessRunOperation = createExecutableRunOperation;

export function createDirectOperations(executor: DirectExecutor): readonly Operation<unknown, unknown>[] {
  return [createShellRunOperation(executor) as Operation<unknown, unknown>, createExecutableRunOperation(executor) as Operation<unknown, unknown>];
}
