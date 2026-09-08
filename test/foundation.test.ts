import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationContext,
  createRuntimeError,
  createTraceId,
  InMemoryEventSink,
  Redactor,
  Tracer,
} from "../src/index.ts";
import { createFakeOperation } from "../src/operations/fake.ts";
import { OperationRegistry } from "../src/operations/registry.ts";

function contextFor(run: ReturnType<Tracer["startRun"]>) {
  return createOperationContext({
    traceId: run.traceId,
    runId: run.runId,
    spanId: run.spanId,
    actor: "model",
  });
}

test("fake operation emits correlated run and operation lifecycle events", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const run = tracer.startRun({ actor: "model" });
  const registry = new OperationRegistry({ tracer });
  registry.register(createFakeOperation());

  const result = await registry.execute("fake.echo", { value: "hello" }, contextFor(run));
  const completedRun = run.complete();

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected fake operation to succeed");
  assert.equal(result.data.value, "hello");
  assert.equal(result.meta.traceId, run.traceId);
  assert.equal(result.meta.runId, run.runId);
  assert.equal(result.meta.effectClass, "read");
  assert.equal(result.meta.metrics.internalCalls, 1);
  assert.equal(result.meta.metrics.pollCountModel, 0);
  assert.equal(result.meta.metrics.rawOutputBytes, result.meta.metrics.returnedOutputBytes);
  assert.equal(result.meta.metrics.compressionRatio, 1);

  const events = sink.events;
  assert.deepEqual(events.map((event) => event.type), [
    "run.started",
    "operation.started",
    "operation.completed",
    "run.completed",
  ]);
  const operationStarted = events[1];
  const operationCompleted = events[2];
  assert.ok(operationStarted !== undefined);
  assert.ok(operationCompleted !== undefined);
  assert.equal(operationStarted.traceId, run.traceId);
  assert.equal(operationCompleted.traceId, run.traceId);
  assert.equal(operationStarted.runId, run.runId);
  assert.equal(operationCompleted.runId, run.runId);
  assert.equal(operationStarted.spanId, operationCompleted.spanId);
  assert.equal(operationStarted.parentSpanId, run.spanId);
  assert.equal(operationCompleted.parentSpanId, run.spanId);
  assert.equal(completedRun.spanId, run.spanId);
});

test("failed operation emits a failed span and preserves a machine-actionable error", async () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const run = tracer.startRun();
  const registry = new OperationRegistry({ tracer }).register(createFakeOperation());

  const result = await registry.execute("fake.echo", { value: "nope", fail: true }, contextFor(run));
  run.complete();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "FAKE_OPERATION_FAILED");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.effect, "none");
  assert.equal(sink.events[2]?.type, "operation.failed");
  assert.equal(sink.events[2]?.errorCode, "FAKE_OPERATION_FAILED");
});

test("content capture is disabled by default while measurements remain available", () => {
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const traceId = createTraceId();
  const run = tracer.startRun({ traceId });
  tracer.emit({
    traceId: run.traceId,
    runId: run.runId,
    spanId: run.spanId,
    type: "artifact.created",
    actor: "runtime",
    payload: { content: "do not persist this", token: "secret-token" },
    metadata: { provider: "fake", rawOutputBytes: 20 },
  });

  const event = sink.events[1];
  assert.ok(event !== undefined);
  assert.equal("payload" in event, false);
  assert.deepEqual(event.metadata, { provider: "fake", rawOutputBytes: 20 });
  assert.equal(new Redactor().capture("secret").captured, false);
});

test("runtime errors remain a machine-actionable envelope", () => {
  const error = createRuntimeError({
    code: "EFFECT_UNKNOWN",
    message: "The provider response was ambiguous",
    retryable: true,
    effect: "unknown",
    details: { provider: "fake" },
  });
  assert.deepEqual(error, {
    code: "EFFECT_UNKNOWN",
    message: "The provider response was ambiguous",
    retryable: true,
    effect: "unknown",
    details: { provider: "fake" },
  });
});
