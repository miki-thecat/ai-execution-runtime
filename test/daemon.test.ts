import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  AERDaemon,
  createOperationMeta,
  createSemanticOperationEnvelope,
  permissiveEffectPolicy,
  runtimeSuccess,
  SqliteStateStore,
} from "../src/index.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aer-daemon-test-"));
}

test("daemon-owned dispatch durably replays semantic receipts across restart", async () => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  let calls = 0;
  const operation = {
    name: "fixture.safe-write",
    effectClass: "workspace_write" as const,
    execute(input: { readonly value: string }, context: Parameters<NonNullable<typeof operation["execute"]>>[1]) {
      calls += 1;
      return runtimeSuccess({ value: input.value, calls }, createOperationMeta({
        context,
        operation: "fixture.safe-write",
        status: "completed",
        effectClass: "workspace_write",
        effectState: "applied",
      }));
    },
  };

  try {
    const firstState = new SqliteStateStore(dbPath);
    const first = new AERDaemon({ state: firstState, dataRoot: directory, policy: permissiveEffectPolicy() });
    first.registerDevice({ deviceId: first.deviceId, presence: "online", capabilities: { operations: [operation.name] } });
    first.register(operation);
    const envelope = createSemanticOperationEnvelope({
      operation: operation.name,
      input: { value: "safe", secret: "token=do-not-persist" } as { readonly value: string },
      effectClass: "read",
      idempotencyKey: "fixture-receipt",
      principal: "fixture-principal",
      authorityScope: ["project:write", "device:local"],
    });

    const initial = await first.execute(envelope);
    assert.equal(initial.ok, true);
    assert.equal(initial.meta.effectClass, "workspace_write");
    assert.equal(calls, 1);

    const replay = await first.execute({ ...envelope, requestId: "correlation-only", traceId: "trace-correlation-only", runId: "run-correlation-only", deadline: Date.now() + 1 });
    assert.equal(replay.ok, true);
    assert.equal(replay.receipt?.replayed, true);
    assert.equal(calls, 1);

    const conflict = await first.execute({ ...envelope, input: { value: "different" } });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(calls, 1);

    const receiptText = JSON.stringify(firstState.listEntities("effect_receipts"));
    assert.equal(receiptText.includes("do-not-persist"), false);
    assert.equal(firstState.listEvents({ type: "remote.requested" }).length >= 3, true);
    assert.equal(firstState.listEvents({ type: "remote.completed" }).length >= 3, true);
    firstState.close();

    const secondState = new SqliteStateStore(dbPath);
    const second = new AERDaemon({ state: secondState, dataRoot: directory, policy: permissiveEffectPolicy() });
    second.registerDevice({ deviceId: second.deviceId, presence: "online" });
    second.register(operation);
    const afterRestart = await second.execute({ ...envelope, requestId: "after-restart" });
    assert.equal(afterRestart.ok, true);
    assert.equal(afterRestart.receipt?.replayed, true);
    assert.equal(calls, 1);
    secondState.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
