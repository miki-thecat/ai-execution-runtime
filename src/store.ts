import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactRef, Decision, Project, RuntimeEvent, Task } from './types.ts';

type Row = Record<string, unknown>;

const now = (): string => new Date().toISOString();

const asString = (value: unknown): string => String(value ?? '');
const asNumber = (value: unknown): number => Number(value ?? 0);

export class SqliteStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as Row;
    if (asNumber(current.version) < 1) {
      this.database.exec(`
        BEGIN;
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          attempt INTEGER NOT NULL,
          retry_count INTEGER NOT NULL,
          bytes_in INTEGER NOT NULL,
          bytes_out INTEGER NOT NULL,
          summary TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          path TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE decisions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX events_project_time ON events(project_id, started_at DESC);
        CREATE INDEX tasks_project_time ON tasks(project_id, updated_at DESC);
        CREATE INDEX artifacts_project_time ON artifacts(project_id, created_at DESC);
        INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${now()}');
        COMMIT;
      `);
    }
  }

  close(): void {
    this.database.close();
  }

  upsertProject(rootPath: string, projectId = randomUUID()): Project {
    const timestamp = now();
    const existing = this.database.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Row | undefined;
    if (existing !== undefined) {
      this.database.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(timestamp, asString(existing.id));
      return this.toProject({ ...existing, updated_at: timestamp });
    }
    this.database.prepare('INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      projectId,
      rootPath,
      timestamp,
      timestamp,
    );
    return { id: projectId, rootPath, createdAt: timestamp, updatedAt: timestamp };
  }

  getProject(projectId: string): Project | undefined {
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    return row === undefined ? undefined : this.toProject(row);
  }

  addTask(projectId: string, name: string, status: Task['status'] = 'pending', taskId = randomUUID()): Task {
    const timestamp = now();
    this.database.prepare('INSERT INTO tasks(id, project_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      taskId,
      projectId,
      name,
      status,
      timestamp,
      timestamp,
    );
    return { id: taskId, projectId, name, status, createdAt: timestamp, updatedAt: timestamp };
  }

  updateTask(taskId: string, status: Task['status']): void {
    this.database.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), taskId);
  }

  appendEvent(event: RuntimeEvent): void {
    this.database.prepare(`
      INSERT INTO events(
        id, project_id, run_id, task_id, kind, name, status, started_at, ended_at,
        duration_ms, attempt, retry_count, bytes_in, bytes_out, summary, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.projectId,
      event.runId ?? null,
      event.taskId ?? null,
      event.kind,
      event.name,
      event.status,
      event.startedAt,
      event.endedAt ?? null,
      event.durationMs ?? null,
      event.attempt,
      event.retryCount,
      event.bytesIn,
      event.bytesOut,
      event.summary,
      JSON.stringify(event.metadata),
    );
  }

  addArtifact(projectId: string, artifact: ArtifactRef, eventId?: string): void {
    this.database.prepare(`
      INSERT INTO artifacts(id, project_id, event_id, kind, path, media_type, size_bytes, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      projectId,
      eventId ?? null,
      artifact.kind,
      artifact.path,
      artifact.mediaType,
      artifact.sizeBytes,
      artifact.sha256,
      now(),
    );
  }

  addDecision(projectId: string, summary: string, decisionId = randomUUID()): Decision {
    const decision = { id: decisionId, projectId, summary, createdAt: now() };
    this.database.prepare('INSERT INTO decisions(id, project_id, summary, created_at) VALUES (?, ?, ?, ?)').run(
      decision.id,
      decision.projectId,
      decision.summary,
      decision.createdAt,
    );
    return decision;
  }

  recentTasks(projectId: string, limit = 20): Task[] {
    const rows = this.database.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?').all(projectId, limit) as Row[];
    return rows.map((row) => this.toTask(row));
  }

  recentEvents(projectId: string, limit = 50): RuntimeEvent[] {
    const rows = this.database.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY started_at DESC LIMIT ?').all(projectId, limit) as Row[];
    return rows.map((row) => this.toEvent(row));
  }

  recentArtifacts(projectId: string, limit = 20): ArtifactRef[] {
    const rows = this.database.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as Row[];
    return rows.map((row) => this.toArtifact(row));
  }

  recentDecisions(projectId: string, limit = 20): Decision[] {
    const rows = this.database.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      projectId: asString(row.project_id),
      summary: asString(row.summary),
      createdAt: asString(row.created_at),
    }));
  }

  private toProject(row: Row): Project {
    return { id: asString(row.id), rootPath: asString(row.root_path), createdAt: asString(row.created_at), updatedAt: asString(row.updated_at) };
  }

  private toTask(row: Row): Task {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      name: asString(row.name),
      status: asString(row.status) as Task['status'],
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  private toEvent(row: Row): RuntimeEvent {
    const event: RuntimeEvent = {
      id: asString(row.id),
      projectId: asString(row.project_id),
      kind: asString(row.kind) as RuntimeEvent['kind'],
      name: asString(row.name),
      status: asString(row.status) as RuntimeEvent['status'],
      startedAt: asString(row.started_at),
      attempt: asNumber(row.attempt),
      retryCount: asNumber(row.retry_count),
      bytesIn: asNumber(row.bytes_in),
      bytesOut: asNumber(row.bytes_out),
      summary: asString(row.summary),
      metadata: JSON.parse(asString(row.metadata_json)) as RuntimeEvent['metadata'],
    };
    if (row.run_id !== null && row.run_id !== undefined) event.runId = asString(row.run_id);
    if (row.task_id !== null && row.task_id !== undefined) event.taskId = asString(row.task_id);
    if (row.ended_at !== null && row.ended_at !== undefined) event.endedAt = asString(row.ended_at);
    if (row.duration_ms !== null && row.duration_ms !== undefined) event.durationMs = asNumber(row.duration_ms);
    return event;
  }

  private toArtifact(row: Row): ArtifactRef {
    return {
      id: asString(row.id),
      kind: asString(row.kind) as ArtifactRef['kind'],
      path: asString(row.path),
      mediaType: asString(row.media_type),
      sizeBytes: asNumber(row.size_bytes),
      sha256: asString(row.sha256),
    };
  }
}
