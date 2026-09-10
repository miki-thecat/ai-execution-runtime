import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore, type ArtifactStore } from "../src/artifacts/index.ts";
import { createOperationContext, createRunId, createTraceId, permissiveEffectPolicy } from "../src/core/index.ts";
import { DirectExecutor } from "../src/direct/index.ts";
import { InMemoryEventSink, Tracer } from "../src/observability/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";

function contextFor(tracer: Tracer) {
  const run = tracer.startRun({ traceId: createTraceId(), runId: createRunId(), actor: "model" });
  return { run, context: createOperationContext({ traceId: run.traceId, runId: run.runId, spanId: run.spanId, actor: "model", effectPolicy: permissiveEffectPolicy() }) };
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

test("a narrower context deadline does not leave the wider process timeout referenced after completion", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const run = tracer.startRun({ actor: "model" });
  const context = createOperationContext({
    traceId: run.traceId,
    runId: run.runId,
    spanId: run.spanId,
    actor: "model",
    effectPolicy: permissiveEffectPolicy(),
    deadline: Date.now() + 5_000,
  });
  const before = process.getActiveResourcesInfo().filter((value) => value === "Timeout").length;
  const executor = new DirectExecutor({ tracer });
  const result = await executor.runShell({ command: "printf done", timeoutMs: 60_000 }, context);
  assert.equal(result.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  const after = process.getActiveResourcesInfo().filter((value) => value === "Timeout").length;
  assert.equal(after, before);
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
    command: "printf \"$AER_TEST_VALUE\"",
    env: { AER_TEST_VALUE: secret },
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.stdout, secret);
  assert.equal(JSON.stringify(sink.events).includes(secret), false);
  assert.equal(JSON.stringify(sink.events).includes("AER_TEST_SECRET"), false);
});

test("raw direct execution keeps a destructive default while trusted reads use least privilege", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const run = tracer.startRun({ actor: "model" });
  const readOnly = createOperationContext({
    traceId: run.traceId,
    runId: run.runId,
    spanId: run.spanId,
    actor: "model",
    effectPolicy: { allowedClasses: ["read"] },
  });
  const executor = new DirectExecutor({ tracer });

  const raw = await executor.runShell({ command: "printf blocked" }, readOnly);
  assert.equal(raw.ok, false);
  if (raw.ok) return;
  assert.equal(raw.error.code, "EFFECT_NOT_ALLOWED");
  assert.equal(raw.meta.effectClass, "destructive");
  assert.equal(sink.events.some((event) => event.type === "process.started"), false);

  const inspect = await executor.runExecutable({ executable: "git", args: ["--version"] }, readOnly, { effectClass: "read" });
  assert.equal(inspect.ok, true);
  if (!inspect.ok) return;
  assert.equal(inspect.meta.effectClass, "read");
  assert.equal(inspect.meta.effectState, "applied");
  const processEvents = sink.events.filter((event) => event.type.startsWith("process."));
  assert.deepEqual(processEvents.map((event) => event.effectClass), ["read", "read"]);
  assert.equal(processEvents.at(-1)?.effectState, "applied");
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

test("durable process reconciliation state excludes argv and shell source", async () => {
  const state = new SqliteStateStore(":memory:");
  const tracer = new Tracer({ sink: state });
  try {
    const { context } = contextFor(tracer);
    const executor = new DirectExecutor({ tracer, state });
    const secret = "token=secret-sentinel";
    const result = await executor.runExecutable({ executable: "printf", args: [secret] }, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const persisted = state.getEntity("processes", result.data.processId);
    assert.equal(JSON.stringify(persisted).includes("secret-sentinel"), false);
    assert.equal(persisted?.data?.argumentCount, 1);

    const shell = await executor.runShell({ command: `printf '${secret}'` }, context);
    assert.equal(shell.ok, true);
    if (!shell.ok) return;
    assert.equal(JSON.stringify(state.getEntity("processes", shell.data.processId)).includes("secret-sentinel"), false);
  } finally {
    state.close();
  }
});

test("artifact failure during process finalization still settles wait with exit evidence", async () => {
  const artifacts = {
    put() { throw new Error("injected artifact failure"); },
    metadata() { return undefined; },
    read() { return new Uint8Array(); },
    has() { return false; },
  } satisfies ArtifactStore;
  const tracer = new Tracer();
  const { context } = contextFor(tracer);
  const executor = new DirectExecutor({ tracer, artifacts, defaultMaxOutputBytes: 1 });
  const handle = executor.startExecutable({ executable: "printf", args: ["long output"] }, context);
  const result = await handle.wait();
  assert.equal(result.status, "unknown");
  assert.equal(result.effectState, "unknown");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "l");
  assert.equal(result.error, "Process output artifact persistence failed");
});

test("direct output spill files are private from creation", async () => {
  const tracer = new Tracer();
  const { context } = contextFor(tracer);
  const executor = new DirectExecutor({ tracer, cancelGraceMs: 20 });
  const handle = executor.startExecutable({ executable: "sh", args: ["-c", "sleep 1"] }, context);
  const spillFiles = readdirSync(tmpdir()).filter((name) => name.startsWith(`aer-direct-${handle.processId}-`));
  try {
    assert.equal(spillFiles.length, 2);
    assert.equal(spillFiles.every((name) => (statSync(join(tmpdir(), name)).mode & 0o777) === 0o600), true);
  } finally {
    await handle.cancel();
  }
});
