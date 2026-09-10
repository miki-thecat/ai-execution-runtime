import { assertProjectReferences, authorityMismatch } from "./authority.ts";
import { createOperationContext, createRunId, createRuntimeError, createTraceId, runtimeFailure, runtimeSuccess, createOperationMeta, type OperationContext, type RuntimeError, type RuntimeResult } from "../core/index.ts";
import type { ArtifactRef, ProjectId } from "../core/ids.ts";
import type { EffectState } from "../core/effects.ts";
import type { RuntimeStatus } from "../core/result.ts";
import { DirectExecutor } from "../direct/index.ts";
import type { Operation } from "../operations/operation.ts";
import { Tracer } from "../observability/index.ts";
import type { StateEntity, StateStore } from "../state/store.ts";
import { ProjectRegistry } from "./registry.ts";
import { ensureTracerEventsPersisted } from "./events.ts";
import { LocalGitSnapshot, type GitSnapshotMetrics } from "./git.ts";
import type {
  GitSnapshot,
  ProjectIdentity,
  ProjectIdentityView,
  ProjectInspect,
  ProjectOperationInput,
  ProjectRef,
  ProjectResume,
  ProjectResumeOptions,
  ProjectRuntimeOptions,
  ResumeBlocker,
  ResumeEvent,
  RunSummary,
  TaskSummary,
  VerificationSummary,
} from "./types.ts";
import type { RuntimeEvent } from "../observability/events.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "unknown"]);
const MEANINGFUL_EVENTS = new Set([
  "run.started", "run.completed", "run.failed", "run.cancelled", "run.unknown",
  "task.created", "task.started", "task.blocked", "task.completed", "task.failed", "task.cancelled", "task.unknown",
  "process.completed", "process.cancelled", "process.unknown",
  "changeset.created", "changeset.applied", "changeset.rolled_back",
  "verification.started", "verification.completed",
  "agent.started", "agent.completed", "agent.failed", "agent.cancelled",
]);
const STATE_CONTEXT_LIMIT = 1_000;

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function projectView(project: ProjectIdentity): ProjectIdentityView {
  return {
    projectId: project.projectId,
    id: project.id,
    name: boundedText(project.name, 200),
    rootDir: project.rootDir,
    root: project.root,
    configPath: project.configPath,
    ...(project.goal === undefined ? {} : { goal: boundedText(project.goal, 2_000) }),
    boundary: project.boundary,
  };
}

function unavailableGit(root: string, error: string): GitSnapshot {
  const diff = { filesChanged: 0, insertions: 0, deletions: 0, untrackedFiles: 0, summary: "Git inspection blocked" };
  return {
    available: false,
    root,
    dirty: false,
    ahead: 0,
    behind: 0,
    upstreamDivergence: { ahead: 0, behind: 0 },
    diff,
    diffSummary: diff,
    error,
  };
}

function defaultContext(projectId?: ProjectId): OperationContext {
  return createOperationContext({
    traceId: createTraceId(),
    runId: createRunId(),
    actor: "runtime",
    ...(projectId === undefined ? {} : { projectId }),
  });
}

function errorFor(cause: unknown, code: string, effect: EffectState = "none"): RuntimeError {
  if (cause !== null && typeof cause === "object" && "code" in cause && "message" in cause && "effect" in cause) return cause as RuntimeError;
  return createRuntimeError({ code, message: cause instanceof Error ? cause.message : "Project operation failed", retryable: false, effect });
}

function recordValue(entity: StateEntity, key: string): unknown {
  return entity.data?.[key];
}

function stringValue(entity: StateEntity, key: string): string | undefined {
  const value = recordValue(entity, key);
  return typeof value === "string" ? value : undefined;
}

function artifactRefs(entity: StateEntity | undefined): readonly ArtifactRef[] {
  const value = entity?.data?.artifactRefs;
  return Array.isArray(value) && value.every((ref): ref is ArtifactRef => typeof ref === "string") ? value.slice(0, 20) : [];
}

function compactData(entity: StateEntity, limit = 24): Readonly<Record<string, unknown>> {
  const data = entity.data ?? {};
  const result: Record<string, unknown> = { id: entity.id, ...(entity.status === undefined ? {} : { status: entity.status }), updatedAt: entity.updatedAt };
  const safeKeys = ["title", "name", "summary", "reason", "goal", "message", "taskId", "runId", "verificationId", "agentRunId", "artifactRefs", "blocker", "blockedBy", "effectState", "passed"];
  for (const key of safeKeys) {
    if (Object.keys(result).length >= limit) break;
    const value = data[key];
    if (value === undefined) continue;
    if (typeof value === "string") result[key] = value.slice(0, 500);
    else if (typeof value === "number" || typeof value === "boolean") result[key] = value;
    else if (key === "artifactRefs" && Array.isArray(value)) result[key] = value.filter((item): item is string => typeof item === "string").slice(0, 20);
    else if (typeof value === "object" && value !== null) result[key] = JSON.stringify(value).slice(0, 2_000);
  }
  return result;
}

function taskSummary(entity: StateEntity): TaskSummary | undefined {
  if (entity.runId === undefined || entity.status === undefined) return undefined;
  const title = stringValue(entity, "title") ?? entity.id;
  const reason = stringValue(entity, "reason");
  return {
    taskId: entity.id as import("../core/ids.ts").TaskId,
    runId: entity.runId as import("../core/ids.ts").RunId,
    title: boundedText(title, 500),
    status: entity.status as RuntimeStatus,
    updatedAt: entity.updatedAt ?? entity.createdAt ?? "",
    ...(reason === undefined ? {} : { reason: boundedText(reason, 1_000) }),
  };
}

function verificationSummary(entity: StateEntity | undefined, currentTrustedDigest?: string): VerificationSummary | undefined {
  if (entity === undefined) return undefined;
  const passed = recordValue(entity, "passed");
  const summary = stringValue(entity, "summary");
  const coverage = recordValue(entity, "coverage");
  const recordedCanonicalPassed = recordValue(entity, "canonicalPassed");
  const trustedPlanDigest = stringValue(entity, "trustedPlanDigest");
  const executionPosture = recordValue(entity, "executionPosture");
  const canonicalPassed = recordedCanonicalPassed === true && coverage === "full" && trustedPlanDigest !== undefined && trustedPlanDigest === currentTrustedDigest;
  return {
    verificationId: entity.id,
    status: (entity.status ?? "unknown") as VerificationSummary["status"],
    ...(typeof passed === "boolean" ? { passed: canonicalPassed } : {}),
    updatedAt: entity.updatedAt ?? entity.createdAt ?? "",
    ...(summary === undefined ? {} : { summary: boundedText(summary, 1_000) }),
    artifactRefs: artifactRefs(entity),
    ...(coverage === "full" || coverage === "partial" ? { coverage } : {}),
    ...(typeof recordedCanonicalPassed === "boolean" ? { canonicalPassed } : {}),
    ...(trustedPlanDigest === undefined ? {} : { trustedPlanDigest }),
    ...(executionPosture === "host_unisolated" ? { executionPosture } : {}),
  };
}

function latest(entities: readonly StateEntity[]): StateEntity | undefined {
  return [...entities].sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))[0];
}

function newestEntities(entities: readonly StateEntity[]): StateEntity[] {
  return [...entities].sort((a, b) => {
    const timestamp = (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");
    return timestamp === 0 ? b.id.localeCompare(a.id) : timestamp;
  });
}

function recentProjectEvents(state: StateStore | undefined, projectId: ProjectId, runIds: ReadonlySet<string>): RuntimeEvent[] {
  if (state === undefined) return [];
  const events = new Map<string, RuntimeEvent>();
  const add = (entries: readonly RuntimeEvent[]): void => {
    for (const event of entries) if (event.projectId === projectId) events.set(event.eventId, event);
  };
  add(state.listEvents({ projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }));
  for (const runId of runIds) add(state.listEvents({ runId: runId as import("../core/ids.ts").RunId, limit: STATE_CONTEXT_LIMIT, order: "desc" }));
  return [...events.values()].sort((a, b) => {
    const timestamp = b.timestamp.localeCompare(a.timestamp);
    return timestamp === 0 ? b.eventId.localeCompare(a.eventId) : timestamp;
  });
}

function eventMeasurements(event: RuntimeEvent): Readonly<Record<string, number | string>> {
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
    compressionRatio: event.compressionRatio,
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.signal === undefined ? {} : { signal: event.signal }),
  };
}

function active(status: string | undefined): boolean {
  return status !== undefined && !TERMINAL.has(status);
}

function validateLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Project context limits must be positive integers");
  return Math.min(result, 100);
}

/** Project-aware semantic operations over the durable state and live worktree. */
export class ProjectRuntime {
  readonly tracer: Tracer;
  readonly registry: ProjectRegistry;
  readonly git: LocalGitSnapshot;
  readonly direct: DirectExecutor;
  private readonly state: StateStore | undefined;

  constructor(options: ProjectRuntimeOptions = {}) {
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
    this.git = new LocalGitSnapshot({ direct: this.direct });
  }

  register(input: Parameters<ProjectRegistry["register"]>[0]): ProjectIdentity {
    return this.registry.register(input);
  }

  trustVerificationPlan(ref: ProjectRef): ProjectIdentity { return this.registry.trustVerificationPlan(ref); }
  updateTrustedVerificationPlan(ref: ProjectRef): ProjectIdentity { return this.registry.trustVerificationPlan(ref); }
  reconcileRoot(ref: ProjectRef, rootDir?: string): ProjectIdentity { return this.registry.reconcileRoot(ref, rootDir); }

  async inspect(ref: ProjectRef, context?: OperationContext): Promise<RuntimeResult<ProjectInspect>> {
    const project = this.registry.get(ref);
    const operationContext = context ?? defaultContext(project?.projectId);
    const span = this.tracer.startOperation({
      traceId: operationContext.traceId,
      runId: operationContext.runId,
      actor: operationContext.actor,
      operation: "project.inspect",
      effectClass: "read",
      ...(operationContext.spanId === undefined ? {} : { parentSpanId: operationContext.spanId }),
      ...(project === undefined ? {} : { projectId: project.projectId }),
      executor: "runtime",
      provider: "local",
    });
    const spanContext = createOperationContext({
      ...operationContext,
      ...(project === undefined ? {} : { projectId: project.projectId }),
      spanId: span.spanId,
      ...(operationContext.spanId === undefined ? {} : { parentSpanId: operationContext.spanId }),
    });
    try {
      if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
      if (context?.projectId !== undefined && context.projectId !== project.projectId) authorityMismatch("Project target does not match runtime context");
      assertProjectReferences(this.state, spanContext);
      const gitMetrics: GitSnapshotMetrics = { internalCalls: 0, rawOutputBytes: 0, returnedOutputBytes: 0, artifactBytes: 0 };
      const git = project.boundary.root.status === "trusted"
        ? await this.git.snapshot(project.rootDir, spanContext, gitMetrics)
        : unavailableGit(project.rootDir, project.boundary.root.code ?? "PROJECT_ROOT_DRIFT");
      const result = this.inspectData(project, git);
      span.record(gitMetrics);
      const event = span.complete({ summary: "Project inspected" });
      this.persistEvent(event);
      return runtimeSuccess(result, this.meta(spanContext, "project.inspect", "completed", span.startedAt, event.timestamp, git.available ? "Project inspected" : "Project inspected without Git", event.artifactRefs, event.effectState ?? "none", event));
    } catch (cause) {
      const error = errorFor(cause, "PROJECT_INSPECT_FAILED");
      const unknown = error.effect === "unknown";
      const event = unknown ? span.unknown(error) : span.fail(error);
      this.persistEvent(event);
      return runtimeFailure(error, this.meta(spanContext, "project.inspect", unknown ? "unknown" : "failed", span.startedAt, event.timestamp, error.message, [], error.effect, event));
    }
  }

  async resume(ref: ProjectRef, context?: OperationContext, options: ProjectResumeOptions = {}): Promise<RuntimeResult<ProjectResume>> {
    const project = this.registry.get(ref);
    const operationContext = context ?? defaultContext(project?.projectId);
    const span = this.tracer.startOperation({
      traceId: operationContext.traceId,
      runId: operationContext.runId,
      actor: operationContext.actor,
      operation: "project.resume",
      effectClass: "read",
      ...(operationContext.spanId === undefined ? {} : { parentSpanId: operationContext.spanId }),
      ...(project === undefined ? {} : { projectId: project.projectId }),
      executor: "runtime",
      provider: "local",
    });
    const spanContext = createOperationContext({
      ...operationContext,
      ...(project === undefined ? {} : { projectId: project.projectId }),
      spanId: span.spanId,
      ...(operationContext.spanId === undefined ? {} : { parentSpanId: operationContext.spanId }),
    });
    try {
      if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
      if (context?.projectId !== undefined && context.projectId !== project.projectId) authorityMismatch("Project target does not match runtime context");
      assertProjectReferences(this.state, spanContext);
      const gitMetrics: GitSnapshotMetrics = { internalCalls: 0, rawOutputBytes: 0, returnedOutputBytes: 0, artifactBytes: 0 };
      const git = project.boundary.root.status === "trusted"
        ? await this.git.snapshot(project.rootDir, spanContext, gitMetrics)
        : unavailableGit(project.rootDir, project.boundary.root.code ?? "PROJECT_ROOT_DRIFT");
      const result = this.resumeData(project, git, options);
      span.record(gitMetrics);
      const event = span.complete({ summary: "Project resume pack created", artifactRefs: result.artifactRefs });
      this.persistEvent(event);
      return runtimeSuccess(result, this.meta(spanContext, "project.resume", "completed", span.startedAt, event.timestamp, "Project resume pack created", event.artifactRefs, event.effectState ?? "none", event));
    } catch (cause) {
      const error = errorFor(cause, "PROJECT_RESUME_FAILED");
      const unknown = error.effect === "unknown";
      const event = unknown ? span.unknown(error) : span.fail(error);
      this.persistEvent(event);
      return runtimeFailure(error, this.meta(spanContext, "project.resume", unknown ? "unknown" : "failed", span.startedAt, event.timestamp, error.message, [], error.effect, event));
    }
  }

  inspectProject(ref: ProjectRef, context?: OperationContext): Promise<RuntimeResult<ProjectInspect>> {
    return this.inspect(ref, context);
  }

  resumeProject(ref: ProjectRef, context?: OperationContext, options: ProjectResumeOptions = {}): Promise<RuntimeResult<ProjectResume>> {
    return this.resume(ref, context, options);
  }

  inspectData(project: ProjectIdentity, git: GitSnapshot): ProjectInspect {
    const tasks = newestEntities(this.state?.listEntities("tasks", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []);
    const runs = newestEntities(this.state?.listEntities("runs", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []);
    const runIds = new Set([...runs.map((entity) => entity.id), ...tasks.map((entity) => entity.runId).filter((runId): runId is string => runId !== undefined)]);
    const processes = newestEntities(this.state?.listEntities("processes", { limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []).filter((process) => process.projectId === project.projectId);
    const verifications = newestEntities(this.state?.listEntities("verifications", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []);
    const activeTasks = tasks.filter((task) => active(task.status)).map(taskSummary).filter((task): task is TaskSummary => task !== undefined).slice(0, 50).reverse();
    const activeProcesses = processes.filter((process) => active(process.status)).map((process) => ({
      id: process.id,
      ...(process.status === undefined ? {} : { status: process.status }),
      ...(process.updatedAt === undefined ? {} : { updatedAt: process.updatedAt }),
      ...(typeof recordValue(process, "operation") === "string" ? { operation: recordValue(process, "operation") as string } : {}),
      ...(typeof recordValue(process, "pid") === "number" ? { pid: recordValue(process, "pid") as number } : {}),
    })).slice(0, 50).reverse();
    const latestVerification = verificationSummary(latest(verifications), project.trustedVerificationPlan?.digest);
    const capabilities = {
      direct: true,
      git: git.available,
      verification: project.boundary.root.status === "trusted" && project.boundary.identity.status === "trusted" && project.boundary.verificationPlan.status === "trusted",
      resume: true,
    };
    return {
      project: projectView(project),
      projectId: project.projectId,
      name: boundedText(project.name, 200),
      root: project.rootDir,
      ...(project.goal === undefined ? {} : { goal: boundedText(project.goal, 2_000) }),
      git,
      activeTasks,
      activeProcesses,
      ...(latestVerification === undefined ? {} : { latestVerification }),
      capabilities,
      boundary: project.boundary,
    };
  }

  resumeData(project: ProjectIdentity, git: GitSnapshot, options: ProjectResumeOptions = {}): ProjectResume {
    const itemLimit = validateLimit(options.itemLimit, 20);
    const eventLimit = validateLimit(options.eventLimit, 20);
    const tasks = newestEntities([
      ...(this.state?.listEntities("tasks", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []),
      ...(this.state?.listEntities("tasks", { projectId: project.projectId, status: "failed", limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []),
    ].filter((entity, index, entities) => entities.findIndex((candidate) => candidate.id === entity.id) === index));
    const decisions = newestEntities(this.state?.listEntities("decisions", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []);
    const runs = newestEntities(this.state?.listEntities("runs", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []);
    const verifications = newestEntities(this.state?.listEntities("verifications", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []);
    const agents = newestEntities(this.state?.listEntities("agent_runs", { projectId: project.projectId, limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []);
    const runIds = new Set([...runs.map((entity) => entity.id), ...tasks.map((entity) => entity.runId).filter((runId): runId is string => runId !== undefined)]);
    const processes = newestEntities(this.state?.listEntities("processes", { limit: STATE_CONTEXT_LIMIT, order: "desc" }) ?? []).filter((process) => process.projectId === project.projectId);
    const eventRunIds = new Set([...runIds, ...processes.map((process) => process.runId).filter((runId): runId is string => runId !== undefined)]);
    const taskSummaries = tasks.filter((task) => active(task.status)).map(taskSummary).filter((task): task is TaskSummary => task !== undefined).slice(0, itemLimit).reverse();
    const taskRunIds = new Set(tasks.filter((task) => active(task.status)).map((task) => task.runId).filter((runId): runId is string => runId !== undefined));
    const activeRuns: RunSummary[] = runs.filter((run) => active(run.status)).slice(0, itemLimit).map((run) => ({
      runId: run.id as import("../core/ids.ts").RunId,
      status: run.status as RuntimeStatus,
      updatedAt: run.updatedAt ?? run.createdAt ?? "",
      ...(stringValue(run, "summary") === undefined ? {} : { summary: boundedText(stringValue(run, "summary") as string, 1_000) }),
    })).reverse();
    const missingRunLimit = Math.max(0, itemLimit - activeRuns.length);
    for (const runId of [...taskRunIds].filter((runId) => !runs.some((run) => run.id === runId)).slice(0, missingRunLimit)) {
      const task = tasks.find((candidate) => candidate.runId === runId);
      if (task === undefined || task.status === undefined) continue;
      activeRuns.push({ runId: runId as import("../core/ids.ts").RunId, status: task.status as RuntimeStatus, updatedAt: task.updatedAt ?? task.createdAt ?? "", summary: boundedText(stringValue(task, "title") ?? "Task run", 1_000) });
    }
    const latestVerification = verificationSummary(latest(verifications), project.trustedVerificationPlan?.digest);
    const lastAgentEntity = latest(agents);
    const lastAgent = lastAgentEntity === undefined ? undefined : compactData(lastAgentEntity);
    const events = recentProjectEvents(this.state, project.projectId, eventRunIds)
      .filter((event) => MEANINGFUL_EVENTS.has(event.type))
      .slice(0, eventLimit)
      .reverse()
      .map((event): ResumeEvent => ({
        type: event.type,
        timestamp: event.timestamp,
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.summary === undefined ? {} : { summary: event.summary.slice(0, 500) }),
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        artifactRefs: [...event.artifactRefs].slice(0, 20),
      }));
    const blockers: ResumeBlocker[] = [];
    if (project.boundary.root.status !== "trusted") blockers.push({ source: "project:root", message: project.boundary.root.code ?? "Registered project root is not trusted", status: project.boundary.root.status });
    if (project.boundary.identity.status !== "trusted") blockers.push({ source: "project:identity", message: project.boundary.identity.code ?? "Repository identity is not trusted", status: project.boundary.identity.status });
    if (project.boundary.verificationPlan.status !== "trusted") blockers.push({ source: "project:verification-plan", message: project.boundary.verificationPlan.code ?? "Verification plan is not trusted", status: project.boundary.verificationPlan.status });
    for (const task of tasks.filter((candidate) => candidate.status === "blocked" || candidate.status === "waiting_user" || candidate.status === "waiting_approval" || candidate.status === "failed")) {
      blockers.push({ source: `task:${task.id}`, message: boundedText(stringValue(task, "reason") ?? `Task is ${task.status}`, 1_000), ...(task.status === undefined ? {} : { status: task.status }) });
    }
    for (const verification of verifications.filter((candidate) => candidate.status === "failed")) {
      blockers.push({ source: `verification:${verification.id}`, message: boundedText(stringValue(verification, "summary") ?? "Latest verification failed", 1_000), status: "failed" });
    }
    const unknownEffects: ResumeBlocker[] = [];
    for (const entity of [...tasks, ...runs, ...processes, ...agents, ...verifications].filter((candidate) => candidate.status === "unknown" || candidate.data?.effectState === "unknown")) {
      unknownEffects.push({ source: `${entity.kind}:${entity.id}`, message: boundedText(stringValue(entity, "reason") ?? stringValue(entity, "summary") ?? "Effect or runtime state is unknown", 1_000), status: entity.status ?? "unknown" });
    }
    for (const event of recentProjectEvents(this.state, project.projectId, eventRunIds)) {
      if (event.effectState === "unknown") unknownEffects.push({ source: `event:${event.eventId}`, message: boundedText(event.summary ?? "An operation recorded an unknown effect", 1_000), status: "unknown" });
    }
    const refs: ArtifactRef[] = [];
    const addRefs = (values: readonly ArtifactRef[]): void => {
      for (const ref of values) if (!refs.includes(ref) && refs.length < 50) refs.push(ref);
    };
    addRefs(artifactRefs(latest(verifications)));
    addRefs(artifactRefs(lastAgentEntity));
    for (const event of events) addRefs(event.artifactRefs);
    return {
      project: projectView(project),
      projectId: project.projectId,
      identity: { name: boundedText(project.name, 200), root: project.rootDir, ...(project.goal === undefined ? {} : { goal: boundedText(project.goal, 2_000) }) },
      activeDecisions: decisions.filter((decision) => decision.status === undefined || active(decision.status)).slice(0, itemLimit).reverse().map((decision) => compactData(decision)),
      activeTasks: taskSummaries,
      activeRuns,
      recentEvents: events,
      git,
      ...(lastAgent === undefined ? {} : { lastAgent }),
      ...(latestVerification === undefined ? {} : { lastVerification: latestVerification }),
      blockers: blockers.slice(0, itemLimit),
      unknownEffects: unknownEffects.slice(0, itemLimit),
      artifactRefs: refs,
      boundary: project.boundary,
    };
  }

  private meta(context: OperationContext, operation: string, status: "completed" | "failed" | "unknown", startedAt: string, completedAt: string, summary: string, refs: readonly ArtifactRef[], effectState: EffectState = "none", event?: RuntimeEvent) {
    return createOperationMeta({
      context,
      operation,
      status,
      effectClass: "read",
      effectState,
      startedAt,
      completedAt,
      artifactRefs: refs,
      metrics: event === undefined ? { internalCalls: 1, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) } : eventMeasurements(event),
      summary,
      executor: "runtime",
      provider: "local",
    });
  }

  private persistEvent(event: import("../observability/events.ts").RuntimeEvent): void {
    if (this.state !== undefined && this.tracer.sink !== this.state && this.state.getEvent(event.eventId) === undefined) this.state.append(event);
  }
}

export function createProjectInspectOperation(runtime: ProjectRuntime): Operation<ProjectOperationInput, ProjectInspect> {
  return {
    name: "project.inspect",
    effectClass: "read",
    executor: "runtime",
    provider: "local",
    execute(input, context) { return runtime.inspect(input.project, context); },
  };
}

export function createProjectResumeOperation(runtime: ProjectRuntime): Operation<ProjectOperationInput & ProjectResumeOptions, ProjectResume> {
  return {
    name: "project.resume",
    effectClass: "read",
    executor: "runtime",
    provider: "local",
    execute(input, context) { return runtime.resume(input.project, context, input); },
  };
}

export function createProjectOperations(runtime: ProjectRuntime): readonly Operation<unknown, unknown>[] {
  return [
    createProjectInspectOperation(runtime) as Operation<unknown, unknown>,
    createProjectResumeOperation(runtime) as Operation<unknown, unknown>,
  ];
}

export const ProjectOperations = ProjectRuntime;
export const ProjectManager = ProjectRuntime;
