import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore, MAX_ARTIFACT_READ_BYTES } from "../src/artifacts/index.ts";
import { createOperationContext, createProjectId, createRuntimeError, createTaskId, createTraceId, permissiveEffectPolicy } from "../src/core/index.ts";
import { createRuntimeEvent } from "../src/observability/events.ts";
import { Tracer } from "../src/observability/index.ts";
import { OperationRegistry } from "../src/operations/index.ts";
import { CURRENT_STATE_SCHEMA_VERSION, STATE_MIGRATIONS, SqliteStateStore } from "../src/state/index.ts";
import { TaskManager } from "../src/tasks/index.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aer-state-test-"));
}

test("SQLite state survives close and reopen with canonical run events", () => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  try {
    const first = new SqliteStateStore(dbPath);
    const tracer = new Tracer({ sink: first });
    const run = tracer.startRun({ traceId: createTraceId(), actor: "test" });
    const completed = run.complete();
    first.close();

    const reopened = new SqliteStateStore(dbPath);
    assert.equal(reopened.schemaVersion, CURRENT_STATE_SCHEMA_VERSION);
    assert.deepEqual(reopened.listEvents({ runId: run.runId }).map((event) => event.type), [
      "run.started",
      "run.completed",
    ]);
    assert.deepEqual(reopened.getEvent(completed.eventId), completed);
    assert.equal(reopened.getRun(run.runId)?.status, "completed");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("state migration removes legacy raw process commands and verification output", () => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  const legacy = new DatabaseSync(dbPath);
  try {
    for (const migration of STATE_MIGRATIONS.filter(({ version }) => version < 3)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
    }
    const processSecret = "token=legacy-process-sentinel";
    legacy.prepare("INSERT INTO processes (process_id, status, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?)").run(
      "process_legacy", "running", new Date().toISOString(), new Date().toISOString(), JSON.stringify({ executable: "sh", args: [processSecret], command: processSecret, argumentCount: 1 }),
    );
    const verificationSecret = "token=legacy-verification-sentinel";
    legacy.prepare("INSERT INTO verifications (verification_id, status, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?)").run(
      "verification_legacy", "failed", new Date().toISOString(), new Date().toISOString(), JSON.stringify({ evidence: { checks: [{ command: verificationSecret, stdout: verificationSecret, stderr: verificationSecret }] } }),
    );
  } finally {
    legacy.close();
  }
  try {
    const migrated = new SqliteStateStore(dbPath);
    try {
      const processData = migrated.getEntity("processes", "process_legacy")?.data;
      assert.equal("executable" in (processData ?? {}), false);
      assert.equal("args" in (processData ?? {}), false);
      const check = (migrated.getEntity("verifications", "verification_legacy")?.data?.evidence as { checks?: readonly Record<string, unknown>[] } | undefined)?.checks?.[0];
      assert.deepEqual({ command: check?.command, stdout: check?.stdout, stderr: check?.stderr }, { command: "[not persisted]", stdout: "", stderr: "" });
      const raw = new DatabaseSync(dbPath);
      try {
        assert.equal(String(raw.prepare("SELECT data_json FROM processes WHERE process_id = ?").get("process_legacy")?.data_json).includes("legacy-process-sentinel"), false);
        assert.equal(String(raw.prepare("SELECT data_json FROM verifications WHERE verification_id = ?").get("verification_legacy")?.data_json).includes("legacy-verification-sentinel"), false);
      } finally {
        raw.close();
      }
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ambiguous top-level operation terminates its durable run as unknown", async () => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  try {
    const first = new SqliteStateStore(dbPath);
    const tracer = new Tracer({ sink: first });
    const run = tracer.startRun({ actor: "runtime" });
    const registry = new OperationRegistry({ tracer }).register({
      name: "publish.ambiguous",
      effectClass: "remote_write",
      execute() {
        throw createRuntimeError({ code: "PUBLISH_AMBIGUOUS", message: "transport response was lost", retryable: false, effect: "unknown" });
      },
    });
    const result = await registry.execute("publish.ambiguous", undefined, createOperationContext({ traceId: run.traceId, runId: run.runId, spanId: run.spanId, actor: "runtime", effectPolicy: permissiveEffectPolicy() }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    run.unknown(result.error);
    assert.deepEqual(first.listEvents({ runId: run.runId }).map((event) => event.type), ["run.started", "operation.started", "operation.unknown", "run.unknown"]);
    assert.equal(first.getRun(run.runId)?.status, "unknown");
    first.close();

    const reopened = new SqliteStateStore(dbPath);
    assert.equal(reopened.getRun(run.runId)?.status, "unknown");
    assert.equal(reopened.listEvents({ type: "run.failed" }).some((event) => event.runId === run.runId), false);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task unknown events replay as unknown task and run state, never failure", () => {
  const first = new SqliteStateStore(":memory:");
  const tracer = new Tracer({ sink: first });
  const tasks = new TaskManager({ state: first, tracer });
  const task = tasks.create({ title: "reconcile ambiguous process" });
  tasks.start(task.taskId);
  tasks.markUnknown(task.taskId, { reason: "process ownership was lost" });
  const evidence = first.listEvents({ runId: task.runId });

  try {
    assert.equal(evidence.some((event) => event.type === "task.failed"), false);
    assert.equal(evidence.some((event) => event.type === "run.failed"), false);
    assert.equal(evidence.some((event) => event.type === "task.unknown" && event.status === "unknown"), true);
    assert.equal(evidence.some((event) => event.type === "run.unknown" && event.status === "unknown"), true);
    assert.equal(first.getTask(task.taskId)?.status, "unknown");
    assert.equal(first.getRun(task.runId)?.status, "unknown");

    const replayed = new SqliteStateStore(":memory:");
    try {
      for (const event of evidence) replayed.append(event);
      assert.equal(replayed.getTask(task.taskId)?.status, "unknown");
      assert.equal(replayed.getRun(task.runId)?.status, "unknown");
    } finally {
      replayed.close();
    }
  } finally {
    first.close();
  }
});

test("artifacts use stable SHA-256 references and bounded reads", () => {
  const directory = temporaryDirectory();
  try {
    const store = new FileArtifactStore(directory);
    const content = "0123456789".repeat(MAX_ARTIFACT_READ_BYTES);
    const first = store.put(content, {
      mediaType: "text/plain",
      origin: "test",
      sensitivity: "internal",
    });
    const second = store.put(content, { mediaType: "application/octet-stream" });

    assert.equal(first.ref, second.ref);
    assert.equal(first.digest.length, 64);
    assert.equal(first.size, new TextEncoder().encode(content).byteLength);
    assert.equal(store.read(first.ref).byteLength, MAX_ARTIFACT_READ_BYTES);
    assert.equal(store.read(first.ref, { offset: 5, length: 20 }).byteLength, 20);
    assert.equal(store.metadata(first.ref)?.mediaType, "text/plain");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local state and artifacts are private and artifact sensitivity only escalates", () => {
  const directory = temporaryDirectory();
  const dataRoot = join(directory, "private-data");
  const state = new SqliteStateStore({ dataRoot });
  try {
    const artifacts = new FileArtifactStore({ dataRoot, state });
    const first = artifacts.put("same", { sensitivity: "internal" });
    const escalated = artifacts.put("same", { sensitivity: "secret" });
    const reverseFirst = artifacts.put("other", { sensitivity: "secret" });
    const reverseSecond = artifacts.put("other", { sensitivity: "public" });
    assert.equal(escalated.sensitivity, "secret");
    assert.equal(artifacts.metadata(first.ref)?.sensitivity, "secret");
    assert.equal(state.getArtifact(first.ref)?.sensitivity, "secret");
    assert.equal(reverseFirst.sensitivity, "secret");
    assert.equal(reverseSecond.sensitivity, "secret");
    assert.equal(statSync(dataRoot).mode & 0o777, 0o700);
    assert.equal(statSync(join(dataRoot, "aer.db")).mode & 0o777, 0o600);
    assert.equal(statSync(join(artifacts.rootDir, "sha256", first.digest)).mode & 0o777, 0o600);
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent artifact writers cannot overwrite stronger sensitivity metadata", async () => {
  const directory = temporaryDirectory();
  const moduleUrl = new URL("../src/artifacts/store.ts", import.meta.url).href;
  const worker = `
    import { FileArtifactStore } from ${JSON.stringify(moduleUrl)};
    const store = new FileArtifactStore(process.argv[1]);
    for (let index = 0; index < 100; index += 1) store.put("shared concurrent bytes", { sensitivity: process.argv[2] });
  `;
  const run = (sensitivity: "internal" | "secret") => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", worker, directory, sensitivity], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `artifact worker exited ${code}`)));
  });
  try {
    await Promise.all([run("secret"), run("internal")]);
    const artifacts = new FileArtifactStore(directory);
    const metadata = artifacts.put("shared concurrent bytes", { sensitivity: "public" });
    assert.equal(metadata.sensitivity, "secret");
    assert.equal(artifacts.metadata(metadata.ref)?.sensitivity, "secret");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact reads and reuse fail closed when content or identity metadata is tampered", () => {
  const directory = temporaryDirectory();
  try {
    const artifacts = new FileArtifactStore(directory);
    const artifact = artifacts.put("trusted evidence");
    const blob = join(directory, "sha256", artifact.digest);
    writeFileSync(blob, "tampered bytes", { mode: 0o600 });
    assert.throws(() => artifacts.read(artifact.ref), (error: unknown) => (error as { code?: string }).code === "ARTIFACT_INTEGRITY_FAILED");
    assert.throws(() => artifacts.put("trusted evidence"), (error: unknown) => (error as { code?: string }).code === "ARTIFACT_INTEGRITY_FAILED");

    writeFileSync(blob, "trusted evidence", { mode: 0o600 });
    const metadataPath = join(directory, "sha256", `${artifact.digest}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, size: 1 }), { mode: 0o600 });
    assert.throws(() => artifacts.read(artifact.ref), (error: unknown) => (error as { code?: string }).code === "ARTIFACT_INTEGRITY_FAILED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal saveEntity timestamps are coherent and lock contention is bounded", () => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  const state = new SqliteStateStore({ dbPath, busyTimeoutMs: 25 });
  const runId = "run_terminal_save" as import("../src/core/index.ts").RunId;
  try {
    state.saveEntity({ kind: "runs", id: runId, runId, status: "completed", traceId: createTraceId(), updatedAt: "2026-01-01T00:00:01.000Z" });
    assert.equal(state.getRun(runId)?.completedAt, "2026-01-01T00:00:01.000Z");
    state.saveEntity({ kind: "runs", id: runId, runId, status: "completed", traceId: createTraceId(), updatedAt: "2026-01-01T00:00:02.000Z", data: {} });
    assert.equal(state.getRun(runId)?.completedAt, "2026-01-01T00:00:01.000Z");

    const blocker = new DatabaseSync(dbPath);
    try {
      blocker.exec("BEGIN EXCLUSIVE;");
      assert.throws(() => state.saveEntity({ kind: "tasks", id: "task_contended", status: "queued" }), (error: unknown) => (error as { code?: string }).code === "STATE_STORE_BUSY");
      blocker.exec("ROLLBACK;");
    } finally {
      blocker.close();
    }
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable event summaries redact known secret assignments", () => {
  const state = new SqliteStateStore(":memory:");
  try {
    const tracer = new Tracer({ sink: state });
    const run = tracer.startRun({ actor: "test" });
    const span = run.operation({ operation: "provider.fail", effectClass: "read" });
    span.fail(createRuntimeError({ code: "PROVIDER_FAILED", message: "provider failed", retryable: false, effect: "none" }), { summary: "stderr token=secret-sentinel" });
    const persisted = state.listEvents({ runId: run.runId });
    assert.equal(JSON.stringify(persisted).includes("secret-sentinel"), false);
    assert.equal(persisted.at(-1)?.summary, "stderr token=[REDACTED]");
  } finally {
    state.close();
  }
});

test("canonical task events infer materialized status and preserve run project association", () => {
  const store = new SqliteStateStore(":memory:");
  const traceId = createTraceId();
  const projectId = createProjectId();
  const taskId = createTaskId();
  const runId = "run_review" as import("../src/core/index.ts").RunId;
  const started = createRuntimeEvent({
    traceId,
    runId,
    taskId,
    projectId,
    spanId: "span_started" as import("../src/core/index.ts").SpanId,
    actor: "test",
    type: "run.started",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: null,
  });
  const completed = createRuntimeEvent({
    traceId,
    runId,
    taskId,
    spanId: "span_completed" as import("../src/core/index.ts").SpanId,
    actor: "test",
    type: "task.completed",
    timestamp: "2026-01-01T00:00:01.000Z",
  });

  try {
    store.append(started);
    store.append(completed);
    assert.equal(store.getRun(runId)?.projectId, projectId);
    assert.equal(store.getTask(taskId)?.status, "completed");
    assert.equal(store.getEvent(started.eventId)?.payload, null);
  } finally {
    store.close();
  }
});
