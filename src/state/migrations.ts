/**
 * State schema migrations are deliberately data-independent and ordered. A
 * replacement StateStore implementation can preserve this logical schema
 * without exposing SQLite to domain code.
 */
export interface StateMigration {
  readonly version: number;
  readonly sql: string;
}

export const STATE_MIGRATIONS: readonly StateMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        root_path TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        project_id TEXT,
        run_id TEXT,
        task_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        status TEXT NOT NULL,
        actor TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        trace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        project_id TEXT,
        device_id TEXT,
        operation TEXT,
        operation_id TEXT,
        executor TEXT,
        provider TEXT,
        status TEXT,
        summary TEXT,
        duration_ms REAL NOT NULL,
        internal_calls INTEGER NOT NULL,
        retries INTEGER NOT NULL,
        poll_count_internal INTEGER NOT NULL,
        poll_count_model INTEGER NOT NULL,
        input_bytes INTEGER NOT NULL,
        raw_output_bytes INTEGER NOT NULL,
        returned_output_bytes INTEGER NOT NULL,
        artifact_bytes INTEGER NOT NULL,
        files_read INTEGER NOT NULL,
        files_changed INTEGER NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        token_input INTEGER,
        token_output INTEGER,
        token_cached INTEGER,
        compression_ratio REAL NOT NULL,
        effect_class TEXT,
        effect_state TEXT,
        idempotency_key TEXT,
        changeset_id TEXT,
        verification_id TEXT,
        artifact_refs_json TEXT NOT NULL,
        error_code TEXT,
        metadata_json TEXT,
        payload_json TEXT
      );

      CREATE TABLE IF NOT EXISTS processes (
        process_id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        project_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        agent_run_id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        project_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS changesets (
        changeset_id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        project_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS changeset_files (
        changeset_file_id TEXT PRIMARY KEY,
        changeset_id TEXT NOT NULL,
        project_id TEXT,
        run_id TEXT,
        task_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS verifications (
        verification_id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        project_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        project_id TEXT,
        run_id TEXT,
        task_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS effect_receipts (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        project_id TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_ref TEXT PRIMARY KEY,
        digest TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        origin TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}'
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_events_run_timestamp ON events(run_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_project_timestamp ON events(project_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type_timestamp ON events(type, timestamp);
      CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
    `,
  },
  {
    version: 3,
    sql: `
      UPDATE processes
      SET data_json = json_remove(
        data_json,
        '$.executable', '$.args', '$.command', '$.shell',
        '$.env', '$.environment', '$.environmentValues'
      )
      WHERE json_valid(data_json);

      UPDATE verifications
      SET data_json = json_set(
        data_json,
        '$.evidence.checks',
        COALESCE(
          (
            SELECT json_group_array(json(json_set(
              json_remove(value, '$.command'),
              '$.command', '[not persisted]',
              '$.stdout', '',
              '$.stderr', ''
            )))
            FROM json_each(data_json, '$.evidence.checks')
          ),
          json('[]')
        )
      )
      WHERE json_valid(data_json)
        AND json_type(data_json, '$.evidence.checks') = 'array';
    `,
  },
] as const;

export const CURRENT_STATE_SCHEMA_VERSION = STATE_MIGRATIONS.at(-1)?.version ?? 0;
