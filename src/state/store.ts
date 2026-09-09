import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RuntimeEvent } from "../observability/events.ts";
import type { RuntimeStatus } from "../core/result.ts";
import type {
  ArtifactRef,
  DeviceId,
  EventId,
  ProjectId,
  RunId,
  TaskId,
  TraceId,
} from "../core/ids.ts";
import { STATE_MIGRATIONS, CURRENT_STATE_SCHEMA_VERSION } from "./migrations.ts";

export type StateEntityType =
  | "projects"
  | "decisions"
  | "runs"
  | "tasks"
  | "processes"
  | "agent_runs"
  | "changesets"
  | "changeset_files"
  | "verifications"
  | "devices"
  | "effect_receipts";

export interface StateEntity {
  readonly kind: StateEntityType;
  readonly id: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly changesetId?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly traceId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface StateEntityQuery {
  readonly projectId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly status?: string;
  readonly limit?: number;
  /** Defaults to ascending for compatibility; context readers can request newest first. */
  readonly order?: "asc" | "desc";
}

export interface StoredArtifactMetadata {
  readonly ref: ArtifactRef;
  readonly digest: string;
  readonly size: number;
  readonly mediaType: string;
  readonly origin: string;
  readonly sensitivity: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunState {
  readonly runId: RunId;
  readonly traceId: TraceId;
  readonly projectId?: ProjectId;
  readonly status: RuntimeStatus;
  readonly actor?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
}

export interface TaskState {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly projectId?: ProjectId;
  readonly status: RuntimeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The storage contract consumed by runtime/domain code. */
export interface StateStore {
  append(event: RuntimeEvent): void;
  appendEvent(event: RuntimeEvent): void;
  getEvent(eventId: EventId): RuntimeEvent | undefined;
  listEvents(options?: EventQuery): readonly RuntimeEvent[];
  getRun(runId: RunId): RunState | undefined;
  getTask(taskId: TaskId): TaskState | undefined;
  saveEntity(entity: StateEntity): void;
  getEntity(kind: StateEntityType, id: string): StateEntity | undefined;
  listEntities(kind: StateEntityType, query?: StateEntityQuery): readonly StateEntity[];
  registerArtifact(metadata: StoredArtifactMetadata): void;
  getArtifact(ref: ArtifactRef): StoredArtifactMetadata | undefined;
  close(): void;
}

export interface EventQuery {
  readonly eventId?: EventId;
  readonly runId?: RunId;
  readonly projectId?: ProjectId;
  readonly type?: RuntimeEvent["type"];
  readonly limit?: number;
  /** Defaults to ascending for compatibility; context readers can request newest first. */
  readonly order?: "asc" | "desc";
}

export interface SqliteStateStoreOptions {
  /** The database file. Defaults to <dataRoot>/aer.db. Use :memory: for tests. */
  readonly dbPath?: string;
  /** Defaults to ~/.aer. The directory is created when a file database opens. */
  readonly dataRoot?: string;
}

const ENTITY_TABLES: Readonly<Record<StateEntityType, { readonly idColumn: string }>> = {
  projects: { idColumn: "project_id" },
  decisions: { idColumn: "decision_id" },
  runs: { idColumn: "run_id" },
  tasks: { idColumn: "task_id" },
  processes: { idColumn: "process_id" },
  agent_runs: { idColumn: "agent_run_id" },
  changesets: { idColumn: "changeset_id" },
  changeset_files: { idColumn: "changeset_file_id" },
  verifications: { idColumn: "verification_id" },
  devices: { idColumn: "device_id" },
  effect_receipts: { idColumn: "receipt_id" },
};

const EVENT_INSERT_SQL = `
  INSERT INTO events (
    event_id, schema_version, trace_id, run_id, task_id, span_id,
    parent_span_id, timestamp, type, actor, project_id, device_id,
    operation, operation_id, executor, provider, status, summary,
    duration_ms, internal_calls, retries, poll_count_internal, poll_count_model,
    input_bytes, raw_output_bytes, returned_output_bytes, artifact_bytes,
    files_read, files_changed, exit_code, signal, token_input, token_output,
    token_cached, compression_ratio, effect_class, effect_state,
    idempotency_key, changeset_id, verification_id, artifact_refs_json,
    error_code, metadata_json, payload_json
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`;

function nullable(value: unknown): unknown {
  return value === undefined ? null : value;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value === undefined ? {} : value);
  if (encoded === undefined) throw new TypeError("State values must be JSON serializable");
  return encoded;
}

function taskStatusForEvent(type: RuntimeEvent["type"]): RuntimeStatus | undefined {
  switch (type) {
    case "task.created": return "queued";
    case "task.started": return "running";
    case "task.blocked": return "blocked";
    case "task.completed": return "completed";
    case "task.failed": return "failed";
    case "task.cancelled": return "cancelled";
    case "task.unknown": return "unknown";
    default: return undefined;
  }
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(String(value)) as unknown;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid state row: ${key} is not text`);
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}

function numberValue(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`Invalid state row: ${key} is not numeric`);
  }
  return Number(value);
}

function limitValue(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("limit must be a positive integer");
  return Math.min(value, 10_000);
}

function eventFromRow(row: Record<string, unknown>): RuntimeEvent {
  const artifactRefs = parseJson(row.artifact_refs_json);
  if (!Array.isArray(artifactRefs) || !artifactRefs.every((ref): ref is ArtifactRef => typeof ref === "string")) {
    throw new Error("Invalid state row: artifact_refs_json is not an array of references");
  }
  const metadata = parseJson(row.metadata_json);
  const payload = parseJson(row.payload_json);
  const result = {
    schemaVersion: numberValue(row, "schema_version") as RuntimeEvent["schemaVersion"],
    eventId: stringValue(row, "event_id") as EventId,
    traceId: stringValue(row, "trace_id") as TraceId,
    runId: stringValue(row, "run_id") as RunId,
    spanId: stringValue(row, "span_id") as RuntimeEvent["spanId"],
    timestamp: stringValue(row, "timestamp"),
    type: stringValue(row, "type") as RuntimeEvent["type"],
    actor: stringValue(row, "actor"),
    durationMs: numberValue(row, "duration_ms"),
    internalCalls: numberValue(row, "internal_calls"),
    retries: numberValue(row, "retries"),
    pollCountInternal: numberValue(row, "poll_count_internal"),
    pollCountModel: numberValue(row, "poll_count_model"),
    inputBytes: numberValue(row, "input_bytes"),
    rawOutputBytes: numberValue(row, "raw_output_bytes"),
    returnedOutputBytes: numberValue(row, "returned_output_bytes"),
    artifactBytes: numberValue(row, "artifact_bytes"),
    filesRead: numberValue(row, "files_read"),
    filesChanged: numberValue(row, "files_changed"),
    compressionRatio: numberValue(row, "compression_ratio"),
    artifactRefs,
    ...(optionalString(row, "task_id") === undefined ? {} : { taskId: optionalString(row, "task_id") as TaskId }),
    ...(optionalString(row, "parent_span_id") === undefined ? {} : { parentSpanId: optionalString(row, "parent_span_id") as RuntimeEvent["parentSpanId"] }),
    ...(optionalString(row, "project_id") === undefined ? {} : { projectId: optionalString(row, "project_id") as ProjectId }),
    ...(optionalString(row, "device_id") === undefined ? {} : { deviceId: optionalString(row, "device_id") as DeviceId }),
    ...(optionalString(row, "operation") === undefined ? {} : { operation: optionalString(row, "operation") }),
    ...(optionalString(row, "operation_id") === undefined ? {} : { operationId: optionalString(row, "operation_id") as RuntimeEvent["operationId"] }),
    ...(optionalString(row, "executor") === undefined ? {} : { executor: optionalString(row, "executor") }),
    ...(optionalString(row, "provider") === undefined ? {} : { provider: optionalString(row, "provider") }),
    ...(optionalString(row, "status") === undefined ? {} : { status: optionalString(row, "status") as RuntimeEvent["status"] }),
    ...(optionalString(row, "summary") === undefined ? {} : { summary: optionalString(row, "summary") }),
    ...(row.exit_code === null || row.exit_code === undefined ? {} : { exitCode: numberValue(row, "exit_code") }),
    ...(optionalString(row, "signal") === undefined ? {} : { signal: optionalString(row, "signal") }),
    ...(row.token_input === null || row.token_input === undefined ? {} : { tokenInput: numberValue(row, "token_input") }),
    ...(row.token_output === null || row.token_output === undefined ? {} : { tokenOutput: numberValue(row, "token_output") }),
    ...(row.token_cached === null || row.token_cached === undefined ? {} : { tokenCached: numberValue(row, "token_cached") }),
    ...(optionalString(row, "effect_class") === undefined ? {} : { effectClass: optionalString(row, "effect_class") as RuntimeEvent["effectClass"] }),
    ...(optionalString(row, "effect_state") === undefined ? {} : { effectState: optionalString(row, "effect_state") as RuntimeEvent["effectState"] }),
    ...(optionalString(row, "idempotency_key") === undefined ? {} : { idempotencyKey: optionalString(row, "idempotency_key") }),
    ...(optionalString(row, "changeset_id") === undefined ? {} : { changesetId: optionalString(row, "changeset_id") }),
    ...(optionalString(row, "verification_id") === undefined ? {} : { verificationId: optionalString(row, "verification_id") }),
    ...(optionalString(row, "error_code") === undefined ? {} : { errorCode: optionalString(row, "error_code") }),
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }),
    ...(payload === undefined ? {} : { payload }),
  };
  return Object.freeze(result) as RuntimeEvent;
}

export class SqliteStateStore implements StateStore {
  readonly dbPath: string;
  readonly schemaVersion = CURRENT_STATE_SCHEMA_VERSION;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: SqliteStateStoreOptions | string = {}) {
    const normalized: SqliteStateStoreOptions = typeof options === "string" ? { dbPath: options } : options;
    const dataRoot = normalized.dataRoot ?? join(homedir(), ".aer");
    this.dbPath = normalized.dbPath ?? join(dataRoot, "aer.db");
    if (this.dbPath !== ":memory:" && !existsSync(dirname(this.dbPath))) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.database = new DatabaseSync(this.dbPath);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  append(event: RuntimeEvent): void {
    this.appendEvent(event);
  }

  appendEvent(event: RuntimeEvent): void {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(EVENT_INSERT_SQL).run(
        event.eventId, event.schemaVersion, event.traceId, event.runId,
        nullable(event.taskId), event.spanId, nullable(event.parentSpanId), event.timestamp,
        event.type, event.actor, nullable(event.projectId), nullable(event.deviceId),
        nullable(event.operation), nullable(event.operationId), nullable(event.executor), nullable(event.provider),
        nullable(event.status), nullable(event.summary), event.durationMs, event.internalCalls,
        event.retries, event.pollCountInternal, event.pollCountModel, event.inputBytes,
        event.rawOutputBytes, event.returnedOutputBytes, event.artifactBytes, event.filesRead,
        event.filesChanged, nullable(event.exitCode), nullable(event.signal), nullable(event.tokenInput),
        nullable(event.tokenOutput), nullable(event.tokenCached), event.compressionRatio,
        nullable(event.effectClass), nullable(event.effectState), nullable(event.idempotencyKey),
        nullable(event.changesetId), nullable(event.verificationId), json(event.artifactRefs),
        nullable(event.errorCode), event.metadata === undefined ? null : json(event.metadata),
        event.payload === undefined ? null : json(event.payload),
      );
      this.materializeEvent(event);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  getEvent(eventId: EventId): RuntimeEvent | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
    return row === undefined ? undefined : eventFromRow(row);
  }

  listEvents(options: EventQuery = {}): readonly RuntimeEvent[] {
    this.assertOpen();
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.eventId !== undefined) { clauses.push("event_id = ?"); parameters.push(options.eventId); }
    if (options.runId !== undefined) { clauses.push("run_id = ?"); parameters.push(options.runId); }
    if (options.projectId !== undefined) { clauses.push("project_id = ?"); parameters.push(options.projectId); }
    if (options.type !== undefined) { clauses.push("type = ?"); parameters.push(options.type); }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const order = options.order === "desc" ? "DESC" : "ASC";
    const rows = this.database.prepare(`SELECT * FROM events${where} ORDER BY timestamp ${order}, rowid ${order} LIMIT ?`).all(
      ...parameters,
      limitValue(options.limit, 1_000),
    );
    return rows.map(eventFromRow);
  }

  getRun(runId: RunId): RunState | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    if (row === undefined) return undefined;
    const actor = optionalString(row, "actor");
    const projectId = optionalString(row, "project_id");
    const completedAt = optionalString(row, "completed_at");
    return {
      runId: stringValue(row, "run_id") as RunId,
      traceId: stringValue(row, "trace_id") as TraceId,
      status: stringValue(row, "status") as RuntimeStatus,
      startedAt: stringValue(row, "started_at"),
      updatedAt: stringValue(row, "updated_at"),
      ...(projectId === undefined ? {} : { projectId: projectId as ProjectId }),
      ...(actor === undefined ? {} : { actor }),
      ...(completedAt === undefined ? {} : { completedAt }),
    };
  }

  getTask(taskId: TaskId): TaskState | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (row === undefined) return undefined;
    const projectId = optionalString(row, "project_id");
    return {
      taskId: stringValue(row, "task_id") as TaskId,
      runId: stringValue(row, "run_id") as RunId,
      status: stringValue(row, "status") as RuntimeStatus,
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
      ...(projectId === undefined ? {} : { projectId: projectId as ProjectId }),
    };
  }

  saveEntity(entity: StateEntity): void {
    this.assertOpen();
    const table = ENTITY_TABLES[entity.kind];
    const now = new Date().toISOString();
    const createdAt = entity.createdAt ?? now;
    const updatedAt = entity.updatedAt ?? now;
    const traceId = entity.traceId ?? (entity.data?.traceId as string | undefined) ?? "trace_unknown";
    const changesetId = entity.changesetId ?? (entity.data?.changesetId as string | undefined);
    if (entity.kind === "changeset_files" && changesetId === undefined) {
      throw new Error("changeset_files entities require changesetId");
    }
    const columns = [
      table.idColumn,
      ...(table.idColumn === "project_id" ? [] : ["project_id"]),
      ...(table.idColumn === "run_id" ? [] : ["run_id"]),
      ...(table.idColumn === "task_id" ? [] : ["task_id"]),
      ...(entity.kind === "changeset_files" ? ["changeset_id"] : []),
      "status", "created_at", "updated_at", "data_json",
      ...(entity.kind === "runs" ? ["trace_id", "started_at", "completed_at"] : []),
    ];
    const status = entity.status ?? ((entity.kind === "runs" || entity.kind === "tasks") ? "queued" : undefined);
    const values: unknown[] = [
      entity.id,
      ...(table.idColumn === "project_id" ? [] : [nullable(entity.projectId)]),
      ...(table.idColumn === "run_id" ? [] : [nullable(entity.runId)]),
      ...(table.idColumn === "task_id" ? [] : [nullable(entity.taskId)]),
      ...(entity.kind === "changeset_files" ? [changesetId] : []),
      nullable(status), createdAt, updatedAt, json(entity.data),
      ...(entity.kind === "runs" ? [traceId, createdAt, null] : []),
    ];
    const updates = [
      ...(table.idColumn === "project_id" ? [] : ["project_id=excluded.project_id"]),
      ...(table.idColumn === "run_id" ? [] : ["run_id=excluded.run_id"]),
      ...(table.idColumn === "task_id" ? [] : ["task_id=excluded.task_id"]),
      ...(entity.kind === "changeset_files" ? ["changeset_id=excluded.changeset_id"] : []),
      "status=excluded.status", "updated_at=excluded.updated_at", "data_json=excluded.data_json",
      ...(entity.kind === "runs" ? ["trace_id=excluded.trace_id", "started_at=excluded.started_at", "completed_at=excluded.completed_at"] : []),
    ];
    const sql = `INSERT INTO ${entity.kind} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(${table.idColumn}) DO UPDATE SET ${updates.join(", ")}`;
    this.database.prepare(sql).run(...values);
  }

  getEntity(kind: StateEntityType, id: string): StateEntity | undefined {
    this.assertOpen();
    const table = ENTITY_TABLES[kind];
    const row = this.database.prepare(`SELECT * FROM ${kind} WHERE ${table.idColumn} = ?`).get(id);
    return row === undefined ? undefined : this.entityFromRow(kind, row);
  }

  listEntities(kind: StateEntityType, query: StateEntityQuery = {}): readonly StateEntity[] {
    this.assertOpen();
    const table = ENTITY_TABLES[kind];
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    for (const [column, value] of [["project_id", query.projectId], ["run_id", query.runId], ["task_id", query.taskId], ["status", query.status]] as const) {
      if (value !== undefined) { clauses.push(`${column} = ?`); parameters.push(value); }
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const order = query.order === "desc" ? "DESC" : "ASC";
    return this.database.prepare(`SELECT * FROM ${kind}${where} ORDER BY updated_at ${order}, ${table.idColumn} ${order} LIMIT ?`).all(...parameters, limitValue(query.limit, 1_000)).map((row) => this.entityFromRow(kind, row));
  }

  registerArtifact(metadata: StoredArtifactMetadata): void {
    this.assertOpen();
    this.database.prepare(`
      INSERT INTO artifacts (artifact_ref, digest, size, media_type, origin, sensitivity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_ref) DO UPDATE SET updated_at=excluded.updated_at
    `).run(metadata.ref, metadata.digest, metadata.size, metadata.mediaType, metadata.origin, metadata.sensitivity, metadata.createdAt, metadata.updatedAt);
  }

  getArtifact(ref: ArtifactRef): StoredArtifactMetadata | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM artifacts WHERE artifact_ref = ?").get(ref);
    if (row === undefined) return undefined;
    return {
      ref: stringValue(row, "artifact_ref") as ArtifactRef,
      digest: stringValue(row, "digest"),
      size: numberValue(row, "size"),
      mediaType: stringValue(row, "media_type"),
      origin: stringValue(row, "origin"),
      sensitivity: stringValue(row, "sensitivity"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private migrate(): void {
    let current = 0;
    try {
      const row = this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
      if (row !== undefined && row.version !== null) current = Number(row.version);
    } catch {
      current = 0;
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      for (const migration of STATE_MIGRATIONS) {
        if (migration.version <= current) continue;
        this.database.exec(migration.sql);
        this.database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  private materializeEvent(event: RuntimeEvent): void {
    const terminalRunStatus: Readonly<Record<string, RuntimeStatus>> = {
      "run.completed": "completed",
      "run.failed": "failed",
      "run.cancelled": "cancelled",
      "run.unknown": "unknown",
    };
    if (event.type === "run.started" || event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.unknown") {
      const existing = this.getRun(event.runId);
      const status = terminalRunStatus[event.type] ?? event.status ?? existing?.status ?? "running";
      const projectId = event.projectId ?? existing?.projectId;
      const startedAt = existing?.startedAt ?? event.timestamp;
      this.database.prepare(`
        INSERT INTO runs (run_id, trace_id, project_id, status, actor, created_at, started_at, completed_at, updated_at, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
        ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, project_id=excluded.project_id, actor=excluded.actor, completed_at=excluded.completed_at, updated_at=excluded.updated_at
      `).run(event.runId, event.traceId, nullable(projectId), status, event.actor, startedAt, startedAt, status === "completed" || status === "failed" || status === "cancelled" || status === "unknown" ? event.timestamp : null, event.timestamp);
    }
    if (event.taskId !== undefined && (event.type.startsWith("task.") || event.type === "run.started")) {
      const existing = this.getTask(event.taskId);
      const status = event.status ?? taskStatusForEvent(event.type) ?? existing?.status ?? "queued";
      const projectId = event.projectId ?? existing?.projectId;
      this.database.prepare(`
        INSERT INTO tasks (task_id, run_id, project_id, status, created_at, updated_at, data_json)
        VALUES (?, ?, ?, ?, ?, ?, '{}')
        ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, project_id=excluded.project_id, updated_at=excluded.updated_at
      `).run(event.taskId, event.runId, nullable(projectId), status, existing?.createdAt ?? event.timestamp, event.timestamp);
    }
  }

  private entityFromRow(kind: StateEntityType, row: Record<string, unknown>): StateEntity {
    const table = ENTITY_TABLES[kind];
    const projectId = optionalString(row, "project_id");
    const runId = optionalString(row, "run_id");
    const taskId = optionalString(row, "task_id");
    const changesetId = optionalString(row, "changeset_id");
    const status = optionalString(row, "status");
    const data = parseJson(row.data_json);
    return {
      kind,
      id: stringValue(row, table.idColumn),
      ...(projectId === undefined ? {} : { projectId }),
      ...(runId === undefined ? {} : { runId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(changesetId === undefined ? {} : { changesetId }),
      ...(status === undefined ? {} : { status }),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
      ...(kind === "runs" ? { traceId: stringValue(row, "trace_id") } : {}),
      ...(data === undefined ? {} : { data: data as Readonly<Record<string, unknown>> }),
    } as StateEntity;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("StateStore is closed");
  }
}

export function createDefaultStateStore(options: Omit<SqliteStateStoreOptions, "dbPath"> = {}): SqliteStateStore {
  return new SqliteStateStore(options);
}
