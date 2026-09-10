import { assertProjectReferences, authorityMismatch } from "../project/authority.ts";
import {
  createRuntimeError,
  createSpanId,
  createTaskId,
  createTraceId,
  createRunId,
  type OperationContext,
  type ProjectId,
  type RunId,
  type SpanId,
  type TaskId,
  type TraceId,
} from "../core/index.ts";
import type { RuntimeStatus } from "../core/result.ts";
import type { RuntimeEvent } from "../observability/events.ts";
import { Tracer } from "../observability/index.ts";
import type { StateEntity, StateStore } from "../state/store.ts";

/** Public aliases keep the state machine readable while storage uses core names. */
export type TaskStatus = RuntimeStatus;
export type TaskStatusInput = RuntimeStatus | "waiting" | "verify";

export interface TaskRecord {
  readonly taskId: TaskId;
  readonly id: TaskId;
  readonly runId: RunId;
  readonly traceId: TraceId;
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly description?: string;
  readonly goal?: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly goal?: string;
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
  readonly traceId?: TraceId;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TransitionTaskInput {
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskTransitionRequest extends TransitionTaskInput {
  readonly status: TaskStatusInput;
}

export interface TaskManagerOptions {
  readonly state?: StateStore;
  readonly tracer?: Tracer;
  readonly clock?: () => Date;
}

const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled", "unknown"]);

function normalizeStatus(status: TaskStatusInput): TaskStatus {
  if (status === "waiting") return "waiting_user";
  if (status === "verify") return "verifying";
  return status;
}

function isWaiting(status: TaskStatus): boolean {
  return status === "waiting_approval" || status === "waiting_user";
}

function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  if (TERMINAL.has(from)) return false;
  if (to === "unknown" || to === "cancelled") return true;
  if (from === "queued") return to === "running" || isWaiting(to) || to === "blocked" || to === "failed";
  if (from === "running") return isWaiting(to) || to === "blocked" || to === "verifying" || to === "completed" || to === "failed";
  if (isWaiting(from)) return to === "running" || to === "blocked" || to === "failed";
  if (from === "blocked") return to === "running" || isWaiting(to) || to === "failed";
  if (from === "verifying") return to === "completed" || to === "failed" || to === "blocked" || isWaiting(to);
  return false;
}

function stateRecord(entity: StateEntity): TaskRecord | undefined {
  const data = entity.data;
  if (data === undefined || typeof data.title !== "string" || typeof data.traceId !== "string" || entity.runId === undefined) return undefined;
  return {
    taskId: entity.id as TaskId,
    id: entity.id as TaskId,
    runId: entity.runId as RunId,
    traceId: data.traceId as TraceId,
    ...(entity.projectId === undefined ? {} : { projectId: entity.projectId as ProjectId }),
    title: data.title,
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    ...(typeof data.goal === "string" ? { goal: data.goal } : {}),
    status: normalizeStatus(entity.status as TaskStatusInput ?? "queued"),
    createdAt: entity.createdAt ?? new Date(0).toISOString(),
    updatedAt: entity.updatedAt ?? entity.createdAt ?? new Date(0).toISOString(),
    ...(typeof data.startedAt === "string" ? { startedAt: data.startedAt } : {}),
    ...(typeof data.completedAt === "string" ? { completedAt: data.completedAt } : {}),
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
    ...(data.metadata !== undefined && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? { metadata: data.metadata as Readonly<Record<string, unknown>> } : {}),
  };
}

/**
 * Durable task state machine. Chat/session identity is never stored as task
 * authority; the task record and its canonical events are project-owned.
 */
export class TaskManager {
  readonly tracer: Tracer;
  private readonly state: StateStore | undefined;
  private readonly clock: () => Date;
  private readonly memory = new Map<TaskId, TaskRecord>();

  constructor(options: TaskManagerOptions = {}) {
    this.state = options.state;
    this.tracer = options.tracer ?? (options.state === undefined ? new Tracer() : new Tracer({ sink: options.state }));
    this.clock = options.clock ?? (() => new Date());
  }

  create(input: CreateTaskInput, context?: OperationContext): TaskRecord {
    if (input.title.trim() === "") throw new Error("Task title cannot be empty");
    const now = this.clock().toISOString();
    const taskId = createTaskId();
    const runId = input.runId ?? context?.runId ?? createRunId();
    const traceId = input.traceId ?? context?.traceId ?? createTraceId();
    const projectId = input.projectId ?? context?.projectId;
    if (context !== undefined && input.projectId !== undefined && input.projectId !== context.projectId) authorityMismatch("Task project aliases disagree");
    assertProjectReferences(this.state, { ...(projectId === undefined ? {} : { projectId }), runId });
    const task: TaskRecord = {
      taskId,
      id: taskId,
      runId,
      traceId,
      ...(projectId === undefined ? {} : { projectId }),
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    this.emitTaskEvent(task, "task.created", "queued", context?.actor ?? "runtime", { summary: "Task created" }, context?.spanId);
    this.persistRun(task);
    this.persist(task);
    this.memory.set(taskId, task);
    return task;
  }

  createTask(input: CreateTaskInput, context?: OperationContext): TaskRecord {
    return this.create(input, context);
  }

  get(taskId: TaskId): TaskRecord | undefined {
    const entity = this.state?.getEntity("tasks", taskId);
    const persisted = entity === undefined ? undefined : stateRecord(entity);
    return persisted ?? this.memory.get(taskId);
  }

  require(taskId: TaskId): TaskRecord {
    const task = this.get(taskId);
    if (task === undefined) throw new Error(`Task is not found: ${taskId}`);
    return task;
  }

  list(projectId?: ProjectId): readonly TaskRecord[] {
    const persisted = this.state === undefined
      ? []
      : this.state.listEntities("tasks", projectId === undefined ? {} : { projectId }).map(stateRecord).filter((task): task is TaskRecord => task !== undefined);
    const records = persisted.length > 0 ? persisted : [...this.memory.values()].filter((task) => projectId === undefined || task.projectId === projectId);
    return records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  transition(taskId: TaskId, requestedStatus: TaskStatusInput | TaskTransitionRequest, input: TransitionTaskInput = {}, context?: OperationContext): TaskRecord {
    const current = this.require(taskId);
    if (context !== undefined && current.projectId !== context.projectId) authorityMismatch("Task belongs to a different project");
    if (context !== undefined) assertProjectReferences(this.state, context);
    const request = typeof requestedStatus === "string" ? undefined : requestedStatus;
    const status = normalizeStatus(typeof requestedStatus === "string" ? requestedStatus : requestedStatus.status);
    const transitionInput = request === undefined ? input : request;
    if (!canTransition(current.status, status)) {
      throw createRuntimeError({
        code: "TASK_INVALID_TRANSITION",
        message: `Task cannot transition from ${current.status} to ${status}`,
        retryable: false,
        effect: "none",
        details: { taskId, from: current.status, to: status },
      });
    }
    if (current.status === status) return current;
    const now = this.clock().toISOString();
    const terminal = TERMINAL.has(status);
    const task: TaskRecord = {
      ...current,
      status,
      updatedAt: now,
      ...(status === "running" && current.startedAt === undefined ? { startedAt: now } : {}),
      ...(terminal ? { completedAt: now } : {}),
      ...(transitionInput.reason === undefined ? {} : { reason: transitionInput.reason }),
      ...(transitionInput.metadata === undefined ? {} : { metadata: transitionInput.metadata }),
    };
    const eventType = status === "completed" ? "task.completed" : status === "failed" ? "task.failed" : status === "cancelled" ? "task.cancelled" : status === "unknown" ? "task.unknown" : status === "blocked" || isWaiting(status) ? "task.blocked" : "task.started";
    this.emitTaskEvent(task, eventType, status, context?.actor ?? "runtime", {
      summary: transitionInput.reason ?? `Task ${status}`,
      metadata: { from: current.status, to: status, ...(transitionInput.metadata ?? {}) },
    }, context?.spanId);
    this.syncTaskRun(task, context?.actor ?? "runtime", context?.spanId);
    this.persist(task);
    this.memory.set(taskId, task);
    return task;
  }

  update(taskId: TaskId, status: TaskStatusInput | TaskTransitionRequest, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, status, input, context);
  }

  start(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "running", input, context);
  }

  wait(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "waiting_user", input, context);
  }

  waitForApproval(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "waiting_approval", input, context);
  }

  block(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "blocked", input, context);
  }

  verify(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "verifying", input, context);
  }

  complete(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "completed", input, context);
  }

  fail(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "failed", input, context);
  }

  cancel(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "cancelled", input, context);
  }

  markUnknown(taskId: TaskId, input?: TransitionTaskInput, context?: OperationContext): TaskRecord {
    return this.transition(taskId, "unknown", input, context);
  }

  private persist(task: TaskRecord): void {
    this.state?.saveEntity({
      kind: "tasks",
      id: task.taskId,
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
      runId: task.runId,
      status: task.status,
      traceId: task.traceId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      data: {
        traceId: task.traceId,
        title: task.title,
        ...(task.description === undefined ? {} : { description: task.description }),
        ...(task.goal === undefined ? {} : { goal: task.goal }),
        ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
        ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
        ...(task.reason === undefined ? {} : { reason: task.reason }),
        ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
      },
    });
  }

  private persistRun(task: TaskRecord): void {
    if (this.state === undefined || this.state.getEntity("runs", task.runId) !== undefined) return;
    this.state.saveEntity({
      kind: "runs",
      id: task.runId,
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
      status: "queued",
      traceId: task.traceId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      data: { taskId: task.taskId, summary: task.title },
    });
  }

  private syncTaskRun(task: TaskRecord, actor: string, parentSpanId?: SpanId): void {
    const run = this.state?.getEntity("runs", task.runId);
    if (run !== undefined && run.data?.taskId !== task.taskId) return;
    const type = task.status === "running"
      ? "run.started"
      : task.status === "completed"
        ? "run.completed"
        : task.status === "failed"
          ? "run.failed"
          : task.status === "cancelled"
            ? "run.cancelled"
            : task.status === "unknown"
              ? "run.unknown"
              : undefined;
    if (type === undefined) return;
    const event = this.tracer.emit({
      traceId: task.traceId,
      runId: task.runId,
      taskId: task.taskId,
      spanId: createSpanId(),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      type,
      actor,
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
      status: task.status,
      summary: task.reason ?? `Task-owned run ${task.status}`,
      ...(task.status === "unknown" ? { effectState: "unknown" as const } : {}),
      metadata: { source: "task", taskId: task.taskId },
    });
    this.persistEvent(event);
  }

  private emitTaskEvent(
    task: TaskRecord,
    type: Extract<RuntimeEvent["type"], `task.${string}`>,
    status: TaskStatus,
    actor: string,
    options: { readonly summary: string; readonly metadata?: Readonly<Record<string, unknown>> },
    parentSpanId?: SpanId,
  ): void {
    const event = this.tracer.emit({
      traceId: task.traceId,
      runId: task.runId,
      spanId: createSpanId(),
      type,
      actor,
      ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
      taskId: task.taskId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      status,
      summary: options.summary,
      ...(status === "unknown" ? { effectState: "unknown" as const } : {}),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
    this.persistEvent(event);
  }

  private persistEvent(event: RuntimeEvent): void {
    if (this.state !== undefined && this.tracer.sink !== this.state && this.state.getEvent(event.eventId) === undefined) this.state.append(event);
  }
}

export const DurableTaskManager = TaskManager;
export const TaskStateMachine = TaskManager;
