import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore, MAX_ARTIFACT_READ_BYTES } from "../src/artifacts/index.ts";
import { createOperationContext, createProjectId, createRuntimeError, createTaskId, createTraceId } from "../src/core/index.ts";
import { createRuntimeEvent } from "../src/observability/events.ts";
import { Tracer } from "../src/observability/index.ts";
import { OperationRegistry } from "../src/operations/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";
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
    assert.equal(reopened.schemaVersion, 2);
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
    const result = await registry.execute("publish.ambiguous", undefined, createOperationContext({ traceId: run.traceId, runId: run.runId, spanId: run.spanId, actor: "runtime" }));
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
