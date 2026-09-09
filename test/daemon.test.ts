import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  AERDaemon,
  createOperationMeta,
  createSemanticOperationEnvelope,
  createRuntimeError,
  createDeviceId,
  fullAlphaDefaultPolicy,
  OperationRegistry,
  permissiveEffectPolicy,
  runtimeFailure,
  runtimeSuccess,
  SqliteStateStore,
} from "../src/index.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aer-daemon-test-"));
}

function endpointFor(directory: string, suffix: string): string {
  // Linux limits pathname Unix sockets to a little over 100 bytes; the test
  // runner's temporary root can itself be deeply nested.
  return join(tmpdir(), `aer-${directory.slice(-4)}-${suffix}.sock`);
}

async function startOrSkip(testContext: { readonly skip: (message?: string) => void }, daemon: AERDaemon): Promise<boolean> {
  try {
    await daemon.start();
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "EPERM") {
      testContext.skip("the execution sandbox does not permit Unix-domain socket listeners");
      return false;
    }
    throw error;
  }
}

test("daemon-owned dispatch durably replays semantic receipts across restart", async (t) => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  let calls = 0;
  let first: AERDaemon | undefined;
  let second: AERDaemon | undefined;
  let firstState: SqliteStateStore | undefined;
  let secondState: SqliteStateStore | undefined;
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
    firstState = new SqliteStateStore(dbPath);
    first = new AERDaemon({ state: firstState, dataRoot: directory, endpoint: endpointFor(directory, "receipt"), policy: permissiveEffectPolicy() });
    first.registerDevice({ deviceId: first.deviceId, presence: "online", capabilities: { operations: [operation.name] } });
    first.register(operation);
    if (!(await startOrSkip(t, first))) return;
    const client = first.client();
    const envelope = createSemanticOperationEnvelope({
      operation: operation.name,
      input: { value: "safe", secret: "token=do-not-persist" } as { readonly value: string },
      effectClass: "read",
      idempotencyKey: "fixture-receipt",
      principal: "fixture-principal",
      authorityScope: ["project:write", "device:local"],
    });

    const initial = await client.execute(envelope);
    assert.equal(initial.ok, true);
    assert.equal(initial.meta.effectClass, "workspace_write");
    assert.equal(calls, 1);

    const replay = await client.execute({ ...envelope, requestId: "correlation-only", traceId: "trace-correlation-only", runId: "run-correlation-only", deadline: Date.now() + 1 });
    assert.equal(replay.ok, true);
    assert.equal(replay.receipt?.replayed, true);
    assert.equal(calls, 1);

    const conflict = await client.execute({ ...envelope, input: { value: "different" } });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(calls, 1);

    const receiptText = JSON.stringify(firstState.listEntities("effect_receipts"));
    assert.equal(receiptText.includes("do-not-persist"), false);
    assert.equal(firstState.listEvents({ type: "remote.requested" }).length >= 3, true);
    assert.equal(firstState.listEvents({ type: "remote.completed" }).length >= 3, true);
    await first.stop();
    firstState.close();
    firstState = undefined;

    secondState = new SqliteStateStore(dbPath);
    second = new AERDaemon({ state: secondState, dataRoot: directory, endpoint: endpointFor(directory, "receipt"), policy: permissiveEffectPolicy() });
    second.registerDevice({ deviceId: second.deviceId, presence: "online" });
    second.register(operation);
    if (!(await startOrSkip(t, second))) return;
    const afterRestart = await second.client().execute({ ...envelope, requestId: "after-restart" });
    assert.equal(afterRestart.ok, true);
    assert.equal(afterRestart.receipt?.replayed, true);
    assert.equal(calls, 1);
    await second.stop();
    secondState.close();
    secondState = undefined;
  } finally {
    await first?.stop();
    await second?.stop();
    firstState?.close();
    secondState?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon ownership is data-root-wide even when endpoint paths differ", async (t) => {
  const directory = temporaryDirectory();
  const first = new AERDaemon({ dataRoot: directory, endpoint: endpointFor(directory, "one") });
  const second = new AERDaemon({ dataRoot: directory, endpoint: endpointFor(directory, "two") });
  try {
    if (!(await startOrSkip(t, first))) return;
    await assert.rejects(second.start(), (error: unknown) => (error as { code?: string }).code === "DAEMON_ALREADY_RUNNING");
    await first.stop();
    if (!(await startOrSkip(t, second))) return;
    assert.equal(second.isRunning, true);
  } finally {
    await first.stop();
    await second.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("started daemon routes multiple client calls over its private local boundary", async (t) => {
  const directory = temporaryDirectory();
  const state = new SqliteStateStore(join(directory, "aer.db"));
  let calls = 0;
  const operation = {
    name: "fixture.local-read",
    effectClass: "read" as const,
    execute(input: { readonly value: string }, context: Parameters<NonNullable<typeof operation["execute"]>>[1]) {
      calls += 1;
      return runtimeSuccess({ value: input.value, calls }, createOperationMeta({ context, operation: "fixture.local-read", status: "completed", effectClass: "read", effectState: "none" }));
    },
  };
  const daemon = new AERDaemon({ dataRoot: directory, state, endpoint: endpointFor(directory, "ipc"), deviceCapabilities: { operations: [operation.name] }, policy: permissiveEffectPolicy() });
  daemon.register(operation);
  try {
    if (!(await startOrSkip(t, daemon))) return;
    const client = daemon.client();
    const first = await client.execute(createSemanticOperationEnvelope({ operation: operation.name, input: { value: "one" }, deviceId: daemon.deviceId }));
    const second = await client.execute(createSemanticOperationEnvelope({ operation: operation.name, input: { value: "two" }, deviceId: daemon.deviceId }));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(calls, 2);
    assert.equal((await client.ping() as { daemon?: string }).daemon, "aer");
    assert.equal(state.listEvents({ type: "remote.requested" }).length, 2);
    assert.equal(state.listEvents({ type: "remote.completed" }).length, 2);
  } finally {
    await daemon.stop();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon resolves policy and root authority from canonical runtime state", async () => {
  const directory = temporaryDirectory();
  const state = new SqliteStateStore(":memory:");
  let calls = 0;
  const operation = {
    name: "fixture.authority-write",
    effectClass: "remote_write" as const,
    execute(_input: unknown, context: Parameters<NonNullable<typeof operation["execute"]>>[1]) {
      calls += 1;
      return runtimeSuccess("should-not-run", createOperationMeta({ context, operation: "fixture.authority-write", status: "completed", effectClass: "remote_write", effectState: "applied" }));
    },
  };
  const injected = new OperationRegistry({ policy: permissiveEffectPolicy() }).register(operation);
  const daemon = new AERDaemon({ dataRoot: directory, state, operations: injected, policy: fullAlphaDefaultPolicy() });
  daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online", capabilities: { operations: [operation.name] } });
  try {
    const denied = await daemon.execute(createSemanticOperationEnvelope({ operation: operation.name, input: { value: "safe" }, effectClass: "read" }));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "EFFECT_APPROVAL_REQUIRED");
    assert.equal(calls, 0);

    const rootEscape = await daemon.execute(createSemanticOperationEnvelope({ operation: "fixture.authority-write", input: { command: { cwd: "/outside" } }, effectClass: "remote_write" }));
    assert.equal(rootEscape.ok, false);
    if (!rootEscape.ok) assert.equal(rootEscape.error.code, "PROJECT_REQUIRED");
    assert.equal(calls, 0);
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("output-budget enforcement preserves provider-reported applied effects", async () => {
  const directory = temporaryDirectory();
  const state = new SqliteStateStore(":memory:");
  const operation = {
    name: "fixture.applied-large-result",
    effectClass: "workspace_write" as const,
    execute(_input: undefined, context: Parameters<NonNullable<typeof operation["execute"]>>[1]) {
      const error = createRuntimeError({ code: "PROVIDER_REPORTED_APPLIED", message: "The effect was applied", retryable: false, effect: "applied", details: { evidence: "x".repeat(100) } });
      return runtimeFailure(error, createOperationMeta({ context, operation: "fixture.applied-large-result", status: "failed", effectClass: "workspace_write", effectState: "applied" }));
    },
  };
  const daemon = new AERDaemon({ dataRoot: directory, state, budgets: { maxOutputBytes: 1, maxReturnedOutputBytes: 1 }, policy: permissiveEffectPolicy() });
  daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online", capabilities: { operations: [operation.name] } });
  daemon.register(operation);
  try {
    const result = await daemon.execute(createSemanticOperationEnvelope({ operation: operation.name, input: undefined }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DAEMON_OUTPUT_TOO_LARGE");
      assert.equal(result.error.effect, "applied");
      assert.equal(result.meta.effectState, "applied");
    }
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous local disconnect never uses a client-declared read effect", async (t) => {
  const directory = temporaryDirectory();
  const state = new SqliteStateStore(":memory:");
  const operation = {
    name: "fixture.slow-write",
    effectClass: "workspace_write" as const,
    async execute(_input: undefined, context: Parameters<NonNullable<typeof operation["execute"]>>[1]) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return runtimeSuccess("done", createOperationMeta({ context, operation: "fixture.slow-write", status: "completed", effectClass: "workspace_write", effectState: "applied" }));
    },
  };
  const daemon = new AERDaemon({ dataRoot: directory, state, endpoint: endpointFor(directory, "slow"), controlTimeoutMs: 5, policy: permissiveEffectPolicy() });
  daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online", capabilities: { operations: [operation.name] } });
  daemon.register(operation);
  try {
    if (!(await startOrSkip(t, daemon))) return;
    const result = await daemon.client().execute(createSemanticOperationEnvelope({ operation: operation.name, effectClass: "read" }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "DAEMON_RESPONSE_UNKNOWN");
      assert.equal(result.error.effect, "unknown");
      assert.equal(result.meta.effectState, "unknown");
      assert.equal(result.meta.effectClass, "workspace_write");
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  } finally {
    await daemon.stop();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart reconciles previously online devices in canonical state", async (t) => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  const firstState = new SqliteStateStore(dbPath);
  const first = new AERDaemon({ dataRoot: directory, state: firstState, endpoint: endpointFor(directory, "restart") });
  const remoteDeviceId = createDeviceId();
  let secondState: SqliteStateStore | undefined;
  let second: AERDaemon | undefined;
  try {
    if (!(await startOrSkip(t, first))) return;
    first.registerDevice({ deviceId: remoteDeviceId, name: "remote-fixture", presence: "online" });
    await first.stop();
    secondState = new SqliteStateStore(dbPath);
    second = new AERDaemon({ dataRoot: directory, state: secondState, endpoint: endpointFor(directory, "restart") });
    assert.equal(secondState.getEntity("devices", remoteDeviceId)?.status, "online");
    if (!(await startOrSkip(t, second))) return;
    assert.equal(second.getDevice(remoteDeviceId)?.presence, "offline");
    assert.equal(secondState.getEntity("devices", remoteDeviceId)?.status, "offline");
    assert.equal(secondState.listEvents({ type: "device.disconnected" }).some((event) => event.deviceId === remoteDeviceId), true);
  } finally {
    await first.stop();
    await second?.stop();
    firstState.close();
    secondState?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
