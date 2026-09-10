import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AERDaemon, createDeviceId, createRunId, createTraceId, createOperationContext, createOperationMeta, createSemanticOperationEnvelope, runtimeSuccess, SqliteStateStore } from "../src/index.ts";
import { sha256 } from "../src/changes/index.ts";
import { FileOperations } from "../src/files/index.ts";
import { TaskManager } from "../src/tasks/index.ts";
import { VerificationRunner } from "../src/verify/index.ts";

// Disposable fixtures and a no-effect operation: rejected requests must never dispatch.
test("registered projects and devices retain their authority boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "aer-authority-"));
  const state = new SqliteStateStore(join(root, "state.db"));
  const daemon = new AERDaemon({ dataRoot: root, state });
  try {
    const projects = ["one", "two"].map(name => {
      const rootDir = join(root, name); mkdirSync(rootDir); writeFileSync(join(rootDir, "note"), "fixture");
      return daemon.registerProject({ rootDir });
    });
    const [one, two] = projects;
    const remote = createDeviceId();
    let calls = 0;
    daemon.register({ name: "fixture.boundary", effectClass: "read", execute: (_input, context) => {
      calls++; return runtimeSuccess("ok", createOperationMeta({ context, operation: "fixture.boundary", status: "completed", effectClass: "read", effectState: "none" }));
    } });
    daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online", capabilities: { operations: ["fixture.boundary"], features: { local: true } } });
    daemon.registerDevice({ deviceId: remote, presence: "online", capabilities: { operations: ["fixture.boundary", "remote.only"], features: { local: false } } });
    const invoke = (extra = {}) => daemon.execute(createSemanticOperationEnvelope({ operation: "fixture.boundary", projectId: one.projectId, input: {}, ...extra }));
    assert.equal((await invoke()).ok, true);
    const rejected = async (extra) => { const before = calls; const result = await invoke(extra); assert.equal(result.ok, false); assert.equal(result.meta.effectState, "none"); assert.equal(calls, before); };
    await rejected({ deviceId: remote });
    await rejected({ deviceId: createDeviceId() });
    await rejected({ deviceId: daemon.deviceId, target: { deviceId: remote } });
    await rejected({ target: { projectId: two.projectId } });
    await rejected({ input: { rootDir: two.rootDir } });
    await rejected({ input: { cwd: ".." } });
    const tasks = new TaskManager({ state });
    const task = tasks.create({ title: "project two", projectId: two.projectId });
    await rejected({ runId: task.runId });
    await rejected({ taskId: task.taskId });
    daemon.registerDevice({ deviceId: remote, presence: "offline" });
    await rejected({ deviceId: remote });
    const reopened = new AERDaemon({ dataRoot: root, state });
    assert.equal(reopened.deviceId, daemon.deviceId);
    assert.equal(reopened.getDevice(remote)?.presence, "offline");
    assert.equal((await reopened.execute(createSemanticOperationEnvelope({ operation: "fixture.boundary", projectId: one.projectId }))).ok, false);

    const context = createOperationContext({ runId: createRunId(), traceId: createTraceId(), actor: "model", projectId: one.projectId });
    const wrong = createOperationContext({ runId: createRunId(), traceId: createTraceId(), actor: "model", projectId: two.projectId });
    const files = new FileOperations({ rootDir: one.rootDir, state, artifacts: daemon.artifacts });
    assert.equal(files.read({ path: "note" }, context).ok, true, JSON.stringify(files.read({ path: "note" }, context)));
    assert.equal(files.read({ path: "note" }, wrong).ok, false);
    assert.equal(files.read({ path: "../two/note" }, context).ok, false);
    assert.throws(() => tasks.start(task.taskId, {}, context));
    assert.throws(() => tasks.create({ title: "bad binding", projectId: one.projectId, runId: task.runId }));
    const patch = files.patch({ path: "note", expectedHash: sha256(new TextEncoder().encode("fixture")), content: "updated" }, context);
    assert.equal(patch.ok, true);
    if (patch.ok) {
      assert.equal(files.changes.rollback({ changeset: patch.data.changeset, context: wrong }).ok, false);
      const otherFiles = new FileOperations({ rootDir: two.rootDir, state, artifacts: daemon.artifacts });
      assert.equal(otherFiles.changes.rollback({ changeset: patch.data.changeset, context }).ok, false);
      assert.equal(files.changes.rollback({ changeset: patch.data.changeset, context }).ok, true);
    }
    const artifact = daemon.artifacts.put("project evidence", { projectId: one.projectId });
    assert.throws(() => daemon.artifacts.read(artifact.ref, { projectId: two.projectId }));
    assert.equal(new TextDecoder().decode(daemon.artifacts.read(artifact.ref, { projectId: one.projectId })), "project evidence");
    const verification = await new VerificationRunner({ registry: daemon.projects, state }).run({ project: two.projectId }, context);
    assert.equal(verification.ok, false);
    if (!verification.ok) assert.equal(verification.error.code, "PROJECT_AUTHORITY_MISMATCH");
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});
