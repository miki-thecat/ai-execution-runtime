import { createOperationContext, createRunId, createRuntimeError, createTraceId, createVerificationId, runtimeFailure, runtimeSuccess, type OperationContext, type ProjectId, type RuntimeError, type RuntimeResult } from "../core/index.ts";
import type { ArtifactRef, VerificationId } from "../core/ids.ts";
import type { EffectState } from "../core/effects.ts";
import { createOperationMeta, type OperationMeta, type RuntimeStatus } from "../core/result.ts";
import { DirectExecutor } from "../direct/index.ts";
import type { ExecutableCommand, ProcessResult, ShellRunInput } from "../direct/types.ts";
import type { Operation } from "../operations/operation.ts";
import { Tracer } from "../observability/index.ts";
import { sanitizeDurableText } from "../observability/redaction.ts";
import type { StateEntity, StateStore } from "../state/store.ts";
import { configuredVerificationCommands, type ConfiguredVerification, type VerificationCommandConfig } from "../project/config.ts";
import { ProjectRegistry } from "../project/registry.ts";
import { ensureTracerEventsPersisted } from "../project/events.ts";
import type { ProjectIdentity, ProjectOperationInput, ProjectRef } from "../project/types.ts";

export type VerificationCheckStatus = "passed" | "failed" | "cancelled" | "unknown";
export type VerificationStatus = "completed" | "failed" | "cancelled" | "unknown";

export interface VerificationCheckEvidence {
  readonly name: string;
  readonly command: string;
  readonly status: VerificationCheckStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly rawOutputBytes: number;
  readonly returnedOutputBytes: number;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly durationMs: number;
  readonly error?: string;
}

export interface VerificationEvidence {
  readonly verificationId: VerificationId;
  readonly id: VerificationId;
  readonly projectId: ProjectId;
  readonly runId: import("../core/ids.ts").RunId;
  readonly status: VerificationStatus;
  readonly passed: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly summary: string;
  readonly checks: readonly VerificationCheckEvidence[];
  readonly artifactRefs: readonly ArtifactRef[];
}

export interface VerificationRunOptions {
  /** Run only named entries from the committed verify list. */
  readonly checkNames?: readonly string[];
}

export interface VerifyRunInput extends VerificationRunOptions {
  readonly project: ProjectRef;
}

export interface VerificationRunnerOptions {
  readonly state?: StateStore;
  readonly tracer?: Tracer;
  readonly artifacts?: import("../artifacts/store.ts").ArtifactStore;
  readonly direct?: DirectExecutor;
  readonly registry?: ProjectRegistry;
  readonly clock?: () => Date;
}

/** Normalized view of the repository-owned verification section. */
export interface VerificationConfig {
  readonly commands: readonly ConfiguredVerification[];
}

export function verificationConfig(project: ProjectIdentity): VerificationConfig {
  return { commands: configuredVerificationCommands(project.config) };
}

interface NormalizedCheck {
  readonly name: string;
  readonly command: string;
  readonly shell: boolean;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const defaultContext = (projectId: ProjectId): OperationContext => createOperationContext({
  traceId: createTraceId(),
  runId: createRunId(),
  projectId,
  actor: "runtime",
});

function errorFor(cause: unknown, code: string, effect: "none" | "unknown" = "none"): RuntimeError {
  if (cause !== null && typeof cause === "object" && "code" in cause && "message" in cause && "effect" in cause) return cause as RuntimeError;
  return createRuntimeError({ code, message: cause instanceof Error ? cause.message : "Verification failed", retryable: false, effect });
}

function commandName(command: ConfiguredVerification, index: number): string {
  if (typeof command === "string") return command.trim().split(/\s+/)[0] ?? `check-${index + 1}`;
  return command.name ?? command.command ?? command.executable ?? `check-${index + 1}`;
}

function normalizeCommand(command: ConfiguredVerification, index: number): NormalizedCheck {
  if (typeof command === "string") return { name: commandName(command, index), command, shell: true };
  const config = command as VerificationCommandConfig;
  if (config.command !== undefined) {
    return {
      name: commandName(command, index),
      command: config.command,
      shell: true,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
    };
  }
  const executable = config.executable ?? "";
  return {
    name: commandName(command, index),
    command: [executable, ...(config.args ?? [])].join(" "),
    shell: false,
    executable,
    args: config.args === undefined ? [] : [...config.args],
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }),
  };
}

function processEvidence(check: NormalizedCheck, result: ProcessResult | undefined, error: RuntimeError | undefined, forcedStatus?: VerificationCheckStatus, failureMeta?: OperationMeta): VerificationCheckEvidence {
  if (result === undefined) {
    const status: VerificationCheckStatus = forcedStatus ?? (error?.effect === "unknown" ? "unknown" : "failed");
    const metrics = failureMeta?.metrics;
    return {
      name: check.name,
      command: check.command,
      status,
      ...(metrics?.exitCode === undefined ? {} : { exitCode: metrics.exitCode }),
      ...(metrics?.signal === undefined ? {} : { signal: metrics.signal }),
      stdout: "",
      stderr: "",
      rawOutputBytes: metrics?.rawOutputBytes ?? 0,
      returnedOutputBytes: metrics?.returnedOutputBytes ?? 0,
      artifactRefs: [...(failureMeta?.artifactRefs ?? [])],
      durationMs: metrics?.durationMs ?? 0,
      ...(error === undefined ? {} : { error: error.message }),
    };
  }
  const status: VerificationCheckStatus = forcedStatus ?? (result.cancelled ? (result.status === "unknown" ? "unknown" : "cancelled") : result.status === "unknown" ? "unknown" : result.exitCode === 0 ? "passed" : "failed");
  return {
    name: check.name,
    command: check.command,
    status,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    stdout: result.stdout,
    stderr: result.stderr,
    rawOutputBytes: result.rawOutputBytes,
    returnedOutputBytes: result.returnedOutputBytes,
    artifactRefs: [...result.artifactRefs],
    durationMs: result.durationMs,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function statusFromChecks(checks: readonly VerificationCheckEvidence[]): VerificationStatus {
  if (checks.some((check) => check.status === "unknown")) return "unknown";
  if (checks.some((check) => check.status === "cancelled")) return "cancelled";
  return checks.every((check) => check.status === "passed") ? "completed" : "failed";
}

function refsFromChecks(checks: readonly VerificationCheckEvidence[]): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const check of checks) for (const ref of check.artifactRefs) if (!refs.includes(ref)) refs.push(ref);
  return refs;
}

function durableEvidence(evidence: VerificationEvidence): VerificationEvidence {
  return {
    ...evidence,
    summary: sanitizeDurableText(evidence.summary),
    checks: evidence.checks.map((check) => ({
      ...check,
      name: sanitizeDurableText(check.name),
      command: "[not persisted]",
      stdout: "",
      stderr: "",
      ...(check.error === undefined ? {} : { error: sanitizeDurableText(check.error) }),
    })),
  };
}

function mergeEffectState(current: EffectState, next: EffectState): EffectState {
  if (current === "unknown" || next === "unknown") return "unknown";
  if (current === "applied" || next === "applied") return "applied";
  return "none";
}

/** Runs only project-configured checks through DirectExecutor and persists evidence. */
export class VerificationRunner {
  readonly tracer: Tracer;
  readonly direct: DirectExecutor;
  readonly registry: ProjectRegistry;
  private readonly state: StateStore | undefined;
  private readonly clock: () => Date;
  private readonly memory = new Map<VerificationId, VerificationEvidence>();

  constructor(options: VerificationRunnerOptions = {}) {
    this.state = options.state;
    this.tracer = options.tracer ?? (options.state === undefined ? new Tracer() : new Tracer({ sink: options.state }));
    ensureTracerEventsPersisted(this.tracer, this.state);
    if (options.direct !== undefined) ensureTracerEventsPersisted(options.direct.tracer, this.state);
    this.registry = options.registry ?? new ProjectRegistry({ ...(options.state === undefined ? {} : { state: options.state }) });
    this.direct = options.direct ?? new DirectExecutor({
      tracer: this.tracer,
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    });
    this.clock = options.clock ?? (() => new Date());
  }

  async run(input: VerifyRunInput | ProjectRef, context?: OperationContext): Promise<RuntimeResult<VerificationEvidence>> {
    const requestedProject = typeof input === "object" && input !== null && "project" in input ? (input as VerifyRunInput).project : input as ProjectRef;
    const options: VerificationRunOptions = typeof input === "object" && input !== null && "project" in input ? input as VerifyRunInput : {};
    const project = this.registry.get(requestedProject);
    const operationContext = context ?? (project === undefined ? createOperationContext({ traceId: createTraceId(), runId: createRunId(), actor: "runtime" }) : defaultContext(project.projectId));
    const span = this.tracer.startOperation({
      traceId: operationContext.traceId,
      runId: operationContext.runId,
      actor: operationContext.actor,
      operation: "verify.run",
      effectClass: "workspace_write",
      ...(operationContext.spanId === undefined ? {} : { parentSpanId: operationContext.spanId }),
      ...(project === undefined ? {} : { projectId: project.projectId }),
      executor: "direct",
      provider: "node:child_process",
    });
    const operationContextWithSpan = createOperationContext({
      ...operationContext,
      ...(project === undefined ? {} : { projectId: project.projectId }),
      spanId: span.spanId,
      ...(operationContext.spanId === undefined ? {} : { parentSpanId: operationContext.spanId }),
    });
    let verificationId: VerificationId | undefined;
    try {
      if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
      const configured = verificationConfig(project).commands;
      if (configured.length === 0) throw createRuntimeError({ code: "VERIFY_NOT_CONFIGURED", message: "No verification commands are configured in .aer/project.json", retryable: false, effect: "none" });
      const checks = configured.map(normalizeCommand).filter((check) => options.checkNames === undefined || options.checkNames.includes(check.name));
      if (checks.length === 0) throw createRuntimeError({ code: "VERIFY_CHECK_NOT_FOUND", message: "No configured verification check matched checkNames", retryable: false, effect: "none" });
      verificationId = createVerificationId();
      const startedAt = this.clock().toISOString();
      this.emitVerification({
        traceId: operationContextWithSpan.traceId,
        runId: operationContextWithSpan.runId,
        projectId: project.projectId,
        verificationId,
        type: "verification.started",
        status: "verifying",
        timestamp: startedAt,
        summary: "Verification started",
      });
      this.persistPartial(verificationId, project, operationContextWithSpan, "verifying", startedAt, []);
      const evidence: VerificationCheckEvidence[] = [];
      let effectState: EffectState = "none";
      for (const check of checks) {
        try {
          const result = check.shell
            ? await this.direct.runShell({ command: check.command, cwd: project.rootDir, ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }), ...(check.maxOutputBytes === undefined ? {} : { maxOutputBytes: check.maxOutputBytes }) } satisfies ShellRunInput, operationContextWithSpan, { instrument: false, effectClass: "workspace_write" })
            : await this.direct.runExecutable({ executable: check.executable ?? "", args: check.args ?? [], cwd: project.rootDir, ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }), ...(check.maxOutputBytes === undefined ? {} : { maxOutputBytes: check.maxOutputBytes }) } satisfies ExecutableCommand, operationContextWithSpan, { instrument: false, effectClass: "workspace_write" });
          if (result.ok) {
            effectState = mergeEffectState(effectState, result.meta.effectState);
            evidence.push(processEvidence(check, result.data, undefined));
            span.record({ internalCalls: 1, rawOutputBytes: result.data.rawOutputBytes, returnedOutputBytes: result.data.returnedOutputBytes, artifactBytes: result.data.artifactBytes });
          } else {
            effectState = mergeEffectState(effectState, result.meta.effectState);
            const checkStatus: VerificationCheckStatus = result.meta.status === "cancelled" ? "cancelled" : result.meta.status === "unknown" || result.error.effect === "unknown" ? "unknown" : "failed";
            evidence.push(processEvidence(check, undefined, result.error, checkStatus, result.meta));
            span.record({ internalCalls: 1, artifactBytes: result.meta.metrics.artifactBytes, rawOutputBytes: result.meta.metrics.rawOutputBytes, returnedOutputBytes: result.meta.metrics.returnedOutputBytes });
          }
        } catch (cause) {
          const error = errorFor(cause, "VERIFY_CHECK_FAILED", "unknown");
          effectState = mergeEffectState(effectState, error.effect);
          evidence.push(processEvidence(check, undefined, error));
          span.record({ internalCalls: 1 });
        }
      }
      const status = statusFromChecks(evidence);
      const completedAt = this.clock().toISOString();
      const passed = status === "completed";
      const summary = passed ? `Verification passed (${evidence.length} check${evidence.length === 1 ? "" : "s"})` : `Verification ${status} (${evidence.length} check${evidence.length === 1 ? "" : "s"})`;
      const resultEvidence: VerificationEvidence = {
        verificationId,
        id: verificationId,
        projectId: project.projectId,
        runId: operationContextWithSpan.runId,
        status,
        passed,
        startedAt,
        completedAt,
        summary,
        checks: evidence,
        artifactRefs: refsFromChecks(evidence),
      };
      this.persistEvidence(resultEvidence, operationContextWithSpan);
      this.emitVerification({
        traceId: operationContextWithSpan.traceId,
        runId: operationContextWithSpan.runId,
        projectId: project.projectId,
        verificationId,
        type: "verification.completed",
        status,
        timestamp: completedAt,
        summary,
        artifactRefs: resultEvidence.artifactRefs,
        effectState,
      });
      const error = status === "completed" ? undefined : createRuntimeError({ code: `VERIFY_${status.toUpperCase()}`, message: summary, retryable: false, effect: effectState });
      const operationEvent = status === "completed" ? span.complete({ summary, artifactRefs: resultEvidence.artifactRefs, effectState }) : status === "cancelled" ? span.cancel({ summary, artifactRefs: resultEvidence.artifactRefs, effectState }) : status === "unknown" ? span.unknown(error!, { summary, artifactRefs: resultEvidence.artifactRefs, effectState }) : span.fail(error!, { summary, artifactRefs: resultEvidence.artifactRefs, effectState });
      this.persistEvent(operationEvent);
      const meta = createOperationMeta({ context: operationContextWithSpan, operation: "verify.run", status: status === "completed" ? "completed" : status, effectClass: "workspace_write", effectState, startedAt: span.startedAt, completedAt: operationEvent.timestamp, artifactRefs: resultEvidence.artifactRefs, metrics: operationEvent, summary, verificationId });
      if (status === "completed") return runtimeSuccess(resultEvidence, meta);
      return runtimeFailure(error!, meta);
    } catch (cause) {
      const error = errorFor(cause, "VERIFY_RUN_FAILED");
      const unknown = error.effect === "unknown";
      const event = unknown ? span.unknown(error, verificationId === undefined ? {} : { summary: error.message }) : span.fail(error, verificationId === undefined ? {} : { summary: error.message });
      this.persistEvent(event);
      return runtimeFailure(error, createOperationMeta({ context: operationContextWithSpan, operation: "verify.run", status: unknown ? "unknown" : "failed", effectClass: "workspace_write", effectState: error.effect, startedAt: span.startedAt, completedAt: event.timestamp, metrics: event, ...(verificationId === undefined ? {} : { verificationId }), summary: error.message }));
    }
  }

  runConfigured(project: ProjectRef, context?: OperationContext, options: VerificationRunOptions = {}): Promise<RuntimeResult<VerificationEvidence>> {
    return this.run({ project, ...options }, context);
  }

  get(verificationId: VerificationId): VerificationEvidence | undefined {
    const entity = this.state?.getEntity("verifications", verificationId);
    const data = entity?.data?.evidence;
    if (data !== undefined && typeof data === "object") return data as VerificationEvidence;
    return this.memory.get(verificationId);
  }

  latest(projectId: ProjectId): VerificationEvidence | undefined {
    const entity = [...(this.state?.listEntities("verifications", { projectId, order: "desc" }) ?? [])].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
    return entity === undefined ? [...this.memory.values()].filter((evidence) => evidence.projectId === projectId).sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0] : this.get(entity.id as VerificationId);
  }

  private persistPartial(id: VerificationId, project: ProjectIdentity, context: OperationContext, status: string, timestamp: string, checks: readonly VerificationCheckEvidence[]): void {
    this.state?.saveEntity({
      kind: "verifications",
      id,
      projectId: project.projectId,
      runId: context.runId,
      status,
      traceId: context.traceId,
      createdAt: timestamp,
      updatedAt: timestamp,
      data: { verificationId: id, traceId: context.traceId, evidence: { verificationId: id, id, projectId: project.projectId, runId: context.runId, status, passed: false, startedAt: timestamp, completedAt: timestamp, summary: "Verification started", checks, artifactRefs: [] } },
    });
  }

  private persistEvidence(evidence: VerificationEvidence, context: OperationContext): void {
    this.memory.set(evidence.verificationId, evidence);
    const persisted = durableEvidence(evidence);
    this.state?.saveEntity({
      kind: "verifications",
      id: evidence.verificationId,
      projectId: evidence.projectId,
      runId: evidence.runId,
      status: evidence.status,
      traceId: context.traceId,
      createdAt: evidence.startedAt,
      updatedAt: evidence.completedAt,
      data: { verificationId: persisted.verificationId, traceId: context.traceId, summary: persisted.summary, passed: persisted.passed, artifactRefs: persisted.artifactRefs, evidence: persisted },
    });
  }

  private emitVerification(input: {
    readonly traceId: import("../core/ids.ts").TraceId;
    readonly runId: import("../core/ids.ts").RunId;
    readonly projectId: ProjectId;
    readonly verificationId: VerificationId;
    readonly type: "verification.started" | "verification.completed";
    readonly status: RuntimeStatus;
    readonly timestamp: string;
    readonly summary: string;
    readonly artifactRefs?: readonly ArtifactRef[];
    readonly effectState?: "none" | "unknown" | "applied";
  }): void {
    const event = this.tracer.emit({
      traceId: input.traceId,
      runId: input.runId,
      spanId: ("span_verification_" + input.verificationId.slice("verification_".length)) as import("../core/ids.ts").SpanId,
      type: input.type,
      actor: "runtime",
      projectId: input.projectId,
      operation: "verify.run",
      verificationId: input.verificationId,
      status: input.status,
      timestamp: input.timestamp,
      summary: input.summary,
      ...(input.artifactRefs === undefined ? {} : { artifactRefs: input.artifactRefs }),
      ...(input.effectState === undefined ? {} : { effectState: input.effectState }),
    });
    this.persistEvent(event);
  }

  private persistEvent(event: import("../observability/events.ts").RuntimeEvent): void {
    if (this.state !== undefined && this.tracer.sink !== this.state && this.state.getEvent(event.eventId) === undefined) this.state.append(event);
  }
}

export function createVerifyRunOperation(runner: VerificationRunner): Operation<ProjectOperationInput & VerificationRunOptions, VerificationEvidence> {
  return {
    name: "verify.run",
    effectClass: "workspace_write",
    executor: "direct",
    provider: "node:child_process",
    execute(input, context) { return runner.run(input, context); },
  };
}

export const createVerificationRunOperation = createVerifyRunOperation;

export const VerifyRunner = VerificationRunner;
export const VerificationManager = VerificationRunner;
