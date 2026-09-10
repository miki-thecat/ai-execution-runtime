import assert from "node:assert/strict";
import test from "node:test";
import { runRecoverySoak } from "../../src/benchmark/recovery-soak.ts";

test("bounded BETA-03 soak replays durable effects and preserves UNKNOWN through recovery", { timeout: 30_000 }, async (t) => {
  const result = await runRecoverySoak();
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.metrics.attemptedOperations, 29);
  assert.equal(result.metrics.successfulOperations, 29);
  assert.equal(result.metrics.restarts, 2);
  assert.equal(result.metrics.recoveries, 2);
  assert.equal(result.metrics.retries, 15);
  assert.equal(result.metrics.unknownTransitions, 3);
  assert.equal(result.metrics.operatorInterventions, 0);
  assert.equal(result.metrics.modelPolls, 0);
  assert.ok(result.metrics.totalLatencyMs >= result.metrics.maximumLatencyMs);
  assert.ok(result.metrics.maximumLatencyMs > 0);
  assert.ok(result.metrics.returnedBytes > 0);
  assert.equal(result.durableEffects, 6);
  assert.equal(result.unknownChildren, 2);
  await t.test("automatic stale daemon owner/socket recovery", (socketTest) => {
    if (result.socket.status === "skipped") socketTest.skip(result.socket.reason);
    else assert.equal(result.socket.status, "passed");
  });
});
