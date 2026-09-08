import { createOperationContext, createRunId, createRuntimeError, createTraceId, runtimeFailure, runtimeSuccess, createOperationMeta, type OperationContext, type RuntimeError, type RuntimeResult } from "../core/index.ts";
import type { ArtifactRef, ProjectId } from "../core/ids.ts";
import type { EffectState } from "../core/effects.ts";
import type { RuntimeStatus } from "../core/result.ts";
import { DirectExecutor } from "../direct/index.ts";
import type { Operation } from "../operations/operation.ts";
import { Tracer } from "../observability/index.ts";
import type { StateEntity, StateStore } from "../state/store.ts";
import { ProjectRegistry } from "./registry.ts";
import { LocalGitSnapshot } from "./git.ts";
import type {
  GitSnapshot,
  ProjectIdentity,
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

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MEANINGFUL_EVENTS = new Set([
  "run.started", "run.completed", "run.failed",
  "task.created", "task.started", "task.blocked", "task.completed", "task.failed", "task.cancelled",
  "process.completed", "process.cancelled", "process.unknown",
  "changeset.created", "changeset.applied", "changeset.rolled_back",
  "verification.started", "verification.completed",
  "agent.started", "agent.completed", "agent.failed", "agent.cancelled",
]);

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
  return Array.isArray(value) && value.every((ref): ref is ArtifactRef => typeof ref === "string") ? value : [];
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
    title,
    status: entity.status as RuntimeStatus,
    updatedAt: entity.updatedAt ?? entity.createdAt ?? "",
    ...(reason === undefined ? {} : { reason }),
  };
}

function verificationSummary(entity: StateEntity | undefined): VerificationSummary | undefined {
  if (entity === undefined) return undefined;
  const passed = recordValue(entity, "passed");
  const summary = stringValue(entity, "summary");
  return {
    verificationId: entity.id,
    status: (entity.status ?? "unknown") as VerificationSummary["status"],
    ...(typeof passed === "boolean" ? { passed } : {}),
    updatedAt: entity.updatedAt ?? entity.createdAt ?? "",
    ...(summary === undefined ? {} : { summary }),
    artifactRefs: artifactRefs(entity),
  };
}

function latest(entities: readonly StateEntity[]): StateEntity | undefined {
  return [...entities].sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))[0];
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
      const git = await this.git.snapshot(project.rootDir, spanContext);
      const result = this.inspectData(project, git);
      span.record({ internalCalls: 1 });
      const event = span.complete({ summary: "Project inspected" });
      this.persistEvent(event);
      return runtimeSuccess(result, this.meta(spanContext, "project.inspect", "completed", span.startedAt, event.timestamp, git.available ? "Project inspected" : "Project inspected without Git", event.artifactRefs));
    } catch (cause) {
      const error = errorFor(cause, "PROJECT_INSPECT_FAILED");
      const event = span.fail(error);
      this.persistEvent(event);
      return runtimeFailure(error, this.meta(spanContext, "project.inspect", "failed", span.startedAt, event.timestamp, error.message, [], error.effect));
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
      const git = await this.git.snapshot(project.rootDir, spanContext);
      const result = this.resumeData(project, git, options);
      span.record({ internalCalls: 1 });
      const event = span.complete({ summary: "Project resume pack created", artifactRefs: result.artifactRefs });
      this.persistEvent(event);
      return runtimeSuccess(result, this.meta(spanContext, "project.resume", "completed", span.startedAt, event.timestamp, "Project resume pack created", event.artifactRefs));
    } catch (cause) {
      const error = errorFor(cause, "PROJECT_RESUME_FAILED");
      const event = span.fail(error);
      this.persistEvent(event);
      return runtimeFailure(error, this.meta(spanContext, "project.resume", "failed", span.startedAt, event.timestamp, error.message, [], error.effect));
    }
  }

  inspectProject(ref: ProjectRef, context?: OperationContext): Promise<RuntimeResult<ProjectInspect>> {
    return this.inspect(ref, context);
  }

  resumeProject(ref: ProjectRef, context?: OperationContext, options: ProjectResumeOptions = {}): Promise<RuntimeResult<ProjectResume>> {
    return this.resume(ref, context, options);
  }

  inspectData(project: ProjectIdentity, git: GitSnapshot): ProjectInspect {
    const tasks = this.state?.listEntities("tasks", { projectId: project.projectId }) ?? [];
    const runs = this.state?.listEntities("runs", { projectId: project.projectId }) ?? [];
    const runIds = new Set([...runs.map((entity) => entity.id), ...tasks.map((entity) => entity.runId).filter((runId): runId is string => runId !== undefined)]);
    const processes = (this.state?.listEntities("processes") ?? []).filter((process) => process.projectId === project.projectId || (process.runId !== undefined && runIds.has(process.runId)) || process.data?.cwd === project.rootDir);
    const verifications = this.state?.listEntities("verifications", { projectId: project.projectId }) ?? [];
    const activeTasks = tasks.filter((task) => active(task.status)).map(taskSummary).filter((task): task is TaskSummary => task !== undefined).slice(-50);
    const activeProcesses = processes.filter((process) => active(process.status)).map((process) => ({
      id: process.id,
      ...(process.status === undefined ? {} : { status: process.status }),
      ...(process.updatedAt === undefined ? {} : { updatedAt: process.updatedAt }),
      ...(typeof recordValue(process, "operation") === "string" ? { operation: recordValue(process, "operation") as string } : {}),
      ...(typeof recordValue(process, "pid") === "number" ? { pid: recordValue(process, "pid") as number } : {}),
    })).slice(-50);
    const latestVerification = verificationSummary(latest(verifications));
    const capabilities = {
      direct: true,
      git: git.available,
      verification: (project.config.verify?.length ?? 0) > 0,
      resume: true,
    };
    return {
      project,
      projectId: project.projectId,
      name: project.name,
      root: project.rootDir,
      ...(project.goal === undefined ? {} : { goal: project.goal }),
      git,
      activeTasks,
      activeProcesses,
      ...(latestVerification === undefined ? {} : { latestVerification }),
      capabilities,
    };
  }

  resumeData(project: ProjectIdentity, git: GitSnapshot, options: ProjectResumeOptions = {}): ProjectResume {
    const itemLimit = validateLimit(options.itemLimit, 20);
    const eventLimit = validateLimit(options.eventLimit, 20);
    const tasks = this.state?.listEntities("tasks", { projectId: project.projectId }) ?? [];
    const decisions = this.state?.listEntities("decisions", { projectId: project.projectId }) ?? [];
    const runs = this.state?.listEntities("runs", { projectId: project.projectId }) ?? [];
    const verifications = this.state?.listEntities("verifications", { projectId: project.projectId }) ?? [];
    const agents = this.state?.listEntities("agent_runs", { projectId: project.projectId }) ?? [];
    const runIds = new Set([...runs.map((entity) => entity.id), ...tasks.map((entity) => entity.runId).filter((runId): runId is string => runId !== undefined)]);
    const processes = (this.state?.listEntities("processes") ?? []).filter((process) => process.projectId === project.projectId || (process.runId !== undefined && runIds.has(process.runId)) || process.data?.cwd === project.rootDir);
    const taskSummaries = tasks.filter((task) => active(task.status)).map(taskSummary).filter((task): task is TaskSummary => task !== undefined).slice(-itemLimit);
    const activeRuns: RunSummary[] = runs.filter((run) => active(run.status)).slice(-itemLimit).map((run) => ({
      runId: run.id as import("../core/ids.ts").RunId,
      status: run.status as RuntimeStatus,
      updatedAt: run.updatedAt ?? run.createdAt ?? "",
      ...(stringValue(run, "summary") === undefined ? {} : { summary: stringValue(run, "summary") as string }),
    }));
    const latestVerification = verificationSummary(latest(verifications));
    const lastAgentEntity = latest(agents);
    const lastAgent = lastAgentEntity === undefined ? undefined : compactData(lastAgentEntity);
    const events = (this.state?.listEvents({ projectId: project.projectId, limit: 1_000 }) ?? [])
      .filter((event) => MEANINGFUL_EVENTS.has(event.type))
      .slice(-eventLimit)
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
    for (const task of tasks.filter((candidate) => candidate.status === "blocked" || candidate.status === "waiting_user" || candidate.status === "waiting_approval")) {
      blockers.push({ source: `task:${task.id}`, message: stringValue(task, "reason") ?? `Task is ${task.status}`, ...(task.status === undefined ? {} : { status: task.status }) });
    }
    for (const verification of verifications.filter((candidate) => candidate.status === "failed")) {
      blockers.push({ source: `verification:${verification.id}`, message: stringValue(verification, "summary") ?? "Latest verification failed", status: "failed" });
    }
    const unknownEffects: ResumeBlocker[] = [];
    for (const entity of [...tasks, ...processes, ...agents, ...verifications].filter((candidate) => candidate.status === "unknown" || candidate.data?.effectState === "unknown")) {
      unknownEffects.push({ source: `${entity.kind}:${entity.id}`, message: stringValue(entity, "reason") ?? stringValue(entity, "summary") ?? "Effect or runtime state is unknown", status: entity.status ?? "unknown" });
    }
    for (const event of this.state?.listEvents({ projectId: project.projectId, limit: 1_000 }) ?? []) {
      if (event.effectState === "unknown") unknownEffects.push({ source: `event:${event.eventId}`, message: event.summary ?? "An operation recorded an unknown effect", status: "unknown" });
    }
    const refs: ArtifactRef[] = [];
    const addRefs = (values: readonly ArtifactRef[]): void => {
      for (const ref of values) if (!refs.includes(ref) && refs.length < 50) refs.push(ref);
    };
    addRefs(artifactRefs(latest(verifications)));
    addRefs(artifactRefs(lastAgentEntity));
    for (const event of events) addRefs(event.artifactRefs);
    return {
      project,
      projectId: project.projectId,
      identity: { name: project.name, root: project.rootDir, ...(project.goal === undefined ? {} : { goal: project.goal }) },
      activeDecisions: decisions.filter((decision) => decision.status === undefined || active(decision.status)).slice(-itemLimit).map((decision) => compactData(decision)),
      activeTasks: taskSummaries,
      activeRuns,
      recentEvents: events,
      git,
      ...(lastAgent === undefined ? {} : { lastAgent }),
      ...(latestVerification === undefined ? {} : { lastVerification: latestVerification }),
      blockers: blockers.slice(0, itemLimit),
      unknownEffects: unknownEffects.slice(0, itemLimit),
      artifactRefs: refs,
    };
  }

  private meta(context: OperationContext, operation: string, status: "completed" | "failed", startedAt: string, completedAt: string, summary: string, refs: readonly ArtifactRef[], effectState: EffectState = "none") {
    return createOperationMeta({
      context,
      operation,
      status,
      effectClass: "read",
      effectState,
      startedAt,
      completedAt,
      artifactRefs: refs,
      metrics: { internalCalls: 1, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) },
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
