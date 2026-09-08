import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore } from "../src/artifacts/index.ts";
import { createOperationContext, createRunId, createTraceId } from "../src/core/index.ts";
import { DirectExecutor } from "../src/direct/index.ts";
import { InMemoryEventSink, Tracer } from "../src/observability/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";

function contextFor(tracer: Tracer) {
  const run = tracer.startRun({ traceId: createTraceId(), runId: createRunId(), actor: "model" });
  return { run, context: createOperationContext({ traceId: run.traceId, runId: run.runId, spanId: run.spanId, actor: "model" }) };
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aer-direct-test-"));
}

test("shell.run returns bounded structured output, status, and canonical lifecycle events", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const { run, context } = contextFor(tracer);
  const directory = temporaryDirectory();
  try {
    const executor = new DirectExecutor({
      tracer,
      artifacts: new FileArtifactStore(directory),
      defaultMaxOutputBytes: 64,
    });
    const result = await executor.runShell({ command: "printf 'hello direct'" }, context);
    run.complete();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.stdout, "hello direct");
    assert.equal(result.data.exitCode, 0);
    assert.equal(result.data.truncated, false);
    assert.equal(result.meta.status, "completed");
    assert.equal(result.meta.metrics.internalCalls, 1);
    assert.equal(result.meta.metrics.pollCountModel, 0);
    assert.deepEqual(sink.events.map((event) => event.type), [
      "run.started",
      "operation.started",
      "process.started",
      "process.completed",
      "operation.completed",
      "run.completed",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("large direct output is bounded and spilled to an artifact", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const { context } = contextFor(tracer);
  const directory = temporaryDirectory();
  try {
    const artifacts = new FileArtifactStore(directory);
    const executor = new DirectExecutor({ tracer, artifacts, defaultMaxOutputBytes: 8 });
    const result = await executor.runShell({ command: "printf 'x%.0s' $(seq 1 16)" }, context);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.stdout, "xxxxxxxx");
    assert.equal(result.data.truncated, true);
    assert.equal(result.data.artifactRefs.length, 1);
    assert.equal(new TextDecoder().decode(artifacts.read(result.data.artifactRefs[0]!)), "xxxxxxxxxxxxxxxx");
    assert.equal(result.meta.metrics.rawOutputBytes, 16);
    assert.equal(result.meta.metrics.returnedOutputBytes, 8);
    assert.equal(result.meta.metrics.artifactBytes, 16);
    assert.equal(JSON.stringify(sink.events).includes("0123456789abcdef"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a long process is cancelled through its runtime-owned handle", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const { context } = contextFor(tracer);
  const executor = new DirectExecutor({ tracer, cancelGraceMs: 20 });
  const handle = executor.startExecutable({ executable: "sh", args: ["-c", "sleep 5"] }, context);
  const result = await handle.cancel();

  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(sink.events.at(-1)?.type, "process.cancelled");
  assert.equal(sink.events.at(-1)?.effectState, "unknown");
});

test("deadline timeout returns a truthful cancelled result and event", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const { context } = contextFor(tracer);
  const executor = new DirectExecutor({ tracer, cancelGraceMs: 20 });
  const result = await executor.runShell({ command: "sleep 1", timeoutMs: 20 }, context);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PROCESS_TIMEOUT");
  assert.equal(result.error.effect, "unknown");
  assert.equal(result.meta.status, "cancelled");
  assert.equal(result.meta.effectState, "unknown");
  assert.equal(sink.events.at(-1)?.effectState, "unknown");
  assert.deepEqual(sink.events.map((event) => event.type), [
    "run.started",
    "operation.started",
    "process.started",
    "process.cancelled",
    "operation.cancelled",
  ]);
});

test("environment values are usable by the child but absent from telemetry", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const { context } = contextFor(tracer);
  const secret = "do-not-log-this-value";
  const executor = new DirectExecutor({ tracer });
  const result = await executor.runShell({
    command: "printf \"$AER_TEST_SECRET\"",
    env: { AER_TEST_SECRET: secret },
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.stdout, secret);
  assert.equal(JSON.stringify(sink.events).includes(secret), false);
  assert.equal(JSON.stringify(sink.events).includes("AER_TEST_SECRET"), true);
});

test("restart reconciliation marks active processes unknown instead of reattaching", () => {
  const state = new SqliteStateStore(":memory:");
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const traceId = createTraceId();
  const runId = createRunId();
  state.saveEntity({
    kind: "processes",
    id: "process_orphaned",
    runId,
    status: "running",
    data: {
      traceId,
      runId,
      spanId: "span_orphaned",
      operation: "process.run",
      operationId: "op_orphaned",
      executable: "sh",
      args: ["-c", "sleep 5"],
      startedAt: new Date().toISOString(),
      reattachable: false,
    },
  });

  try {
    const executor = new DirectExecutor({ tracer, state });
    assert.deepEqual(executor.reconcile(), []);
    assert.equal(state.getEntity("processes", "process_orphaned")?.status, "unknown");
    assert.equal(sink.events[0]?.type, "process.unknown");
    assert.equal(sink.events[0]?.status, "unknown");
    assert.equal(sink.events[0]?.effectState, "unknown");
  } finally {
    state.close();
  }
});
