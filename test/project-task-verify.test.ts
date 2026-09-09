import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { FileArtifactStore } from "../src/artifacts/index.ts";
import { createOperationContext } from "../src/core/index.ts";
import { DirectExecutor } from "../src/direct/index.ts";
import { InMemoryEventSink, Tracer } from "../src/observability/index.ts";
import { ProjectRegistry, ProjectRuntime } from "../src/project/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";
import { TaskManager } from "../src/tasks/index.ts";
import { VerificationRunner } from "../src/verify/index.ts";

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("FA-04 project, task, Git, resume, and verification state survive reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "aer-fa04-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "aer-fa04-runtime-"));
  const dbPath = join(runtimeRoot, "aer.db");
  const state = new SqliteStateStore(dbPath);
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  try {
    writeFileSync(join(root, "README.txt"), "disposable project\n");
    git(root, ["init", "-q"]);
    git(root, ["branch", "-M", "main"]);
    git(root, ["config", "user.email", "aer@example.test"]);
    git(root, ["config", "user.name", "AER test"]);
    git(root, ["add", "README.txt"]);
    git(root, ["commit", "-qm", "initial"]);

    const runtime = new ProjectRuntime({ state, tracer, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    const project = runtime.register({ rootDir: root, name: "Disposable", goal: "Prove FA-04", verify: ["node -e \"process.stdout.write('verified')\""] });
    git(root, ["add", ".aer/project.json"]);
    git(root, ["commit", "-qm", "configure aer"]);

    const inspectRun = tracer.startRun({ projectId: project.projectId, actor: "runtime" });
    const inspected = await runtime.inspect(project, createOperationContext({
      traceId: inspectRun.traceId,
      runId: inspectRun.runId,
      projectId: project.projectId,
      actor: "runtime",
      effectPolicy: { allowedClasses: ["read"] },
    }));
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    assert.equal(inspected.data.projectId, project.projectId);
    assert.equal(inspected.data.git.available, true);
    assert.equal(inspected.data.git.branch, "main");
    assert.equal(inspected.data.git.dirty, false);
    const inspectProcesses = sink.events.filter((event) => event.runId === inspectRun.runId && event.type.startsWith("process."));
    assert.ok(inspectProcesses.length > 0);
    assert.equal(inspectProcesses.every((event) => event.effectClass === "read"), true);
    inspectRun.complete();

    const tasks = new TaskManager({ state, tracer });
    const task = tasks.create({ projectId: project.projectId, title: "verify runtime" });
    tasks.transition(task.taskId, "running");
    tasks.transition(task.taskId, "verifying");
    const completed = tasks.transition(task.taskId, "completed", { reason: "checks passed" });
    assert.equal(completed.status, "completed");

    const reopenedTasks = new TaskManager({ state, tracer });
    assert.equal(reopenedTasks.get(task.taskId)?.status, "completed");
    const unknownTask = tasks.create({ projectId: project.projectId, title: "reconcile unknown effect" });
    tasks.markUnknown(unknownTask.taskId, { reason: "process ownership was lost" });
    const unknownLifecycle = state.listEvents({ runId: unknownTask.runId });
    assert.equal(unknownLifecycle.some((event) => event.type === "task.failed" || event.type === "run.failed"), false);
    assert.equal(unknownLifecycle.some((event) => event.type === "task.unknown"), true);
    assert.equal(unknownLifecycle.some((event) => event.type === "run.unknown"), true);
    assert.equal(state.getRun(unknownTask.runId)?.status, "unknown");

    const run = tracer.startRun({ projectId: project.projectId, actor: "runtime" });
    const context = createOperationContext({ traceId: run.traceId, runId: run.runId, projectId: project.projectId, actor: "runtime" });
    const verification = new VerificationRunner({
      state,
      tracer,
      registry: runtime.registry,
      direct: new DirectExecutor({ tracer, state, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) }),
    });
    const checked = await verification.runConfigured(project, context);
    assert.equal(checked.ok, true);
    if (!checked.ok) return;
    assert.equal(checked.data.passed, true);
    assert.equal(checked.meta.effectClass, "workspace_write");
    assert.equal(checked.meta.effectState, "applied");
    assert.equal(checked.data.checks[0]?.status, "passed");
    assert.equal(checked.data.checks[0]?.stdout, "verified");
    assert.ok(state.getEntity("verifications", checked.data.verificationId));
    const durableVerification = state.getEntity("verifications", checked.data.verificationId);
    assert.equal(JSON.stringify(durableVerification).includes("verified"), false);
    assert.equal((durableVerification?.data?.evidence as { checks?: readonly { stdout?: string; stderr?: string }[] } | undefined)?.checks?.[0]?.stdout, "");
    assert.ok(state.listEvents({ type: "process.started" }).length > 0);
    assert.ok(state.listEvents({ type: "process.completed" }).length > 0);
    assert.equal(state.listEvents({ runId: run.runId }).filter((event) => event.type.startsWith("process.")).every((event) => event.effectClass === "workspace_write"), true);
    run.complete();

    const resumed = await runtime.resume(project, undefined, { eventLimit: 8, itemLimit: 8 });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.data.identity.goal, "Prove FA-04");
    assert.equal(resumed.data.git.head, inspected.data.git.head);
    assert.equal(resumed.data.lastVerification?.passed, true);
    assert.equal(resumed.data.activeTasks.some((entry) => entry.taskId === unknownTask.taskId), false);
    assert.ok(resumed.data.unknownEffects.some((entry) => entry.source === `tasks:${unknownTask.taskId}`));
    assert.ok(resumed.data.unknownEffects.some((entry) => entry.source.startsWith("runs:")));
    assert.ok(resumed.data.recentEvents.length <= 8);
    assert.equal(JSON.stringify(resumed.data).includes("disposable project"), false);
    const eventTypes = new Set(sink.events.map((event) => event.type));
    assert.ok(eventTypes.has("task.created"));
    assert.ok(eventTypes.has("task.completed"));
    assert.ok(eventTypes.has("verification.started"));
    assert.ok(eventTypes.has("verification.completed"));
    assert.ok(eventTypes.has("process.started"));
    assert.ok(eventTypes.has("process.completed"));

    const deniedRun = tracer.startRun({ projectId: project.projectId, actor: "runtime" });
    const processCount = sink.events.filter((event) => event.type === "process.started").length;
    const deniedVerification = await verification.runConfigured(project, createOperationContext({
      traceId: deniedRun.traceId,
      runId: deniedRun.runId,
      projectId: project.projectId,
      actor: "runtime",
      effectPolicy: { allowedClasses: ["read"] },
    }));
    assert.equal(deniedVerification.ok, false);
    if (deniedVerification.ok) return;
    assert.equal(deniedVerification.meta.effectClass, "workspace_write");
    assert.equal(deniedVerification.meta.effectState, "none");
    assert.equal(sink.events.filter((event) => event.type === "process.started").length, processCount);

    state.close();
    const reopenedState = new SqliteStateStore(dbPath);
    try {
      const reopenedRegistry = new ProjectRegistry({ state: reopenedState });
      const reopenedProject = reopenedRegistry.get(project.projectId);
      assert.equal(reopenedProject?.projectId, project.projectId);
      const reopenedEvidence = reopenedState.getEntity("verifications", checked.data.verificationId);
      assert.equal(reopenedEvidence?.status, "completed");
      assert.equal(reopenedState.getTask(unknownTask.taskId)?.status, "unknown");
      assert.equal(reopenedState.getRun(unknownTask.runId)?.status, "unknown");
    } finally {
      reopenedState.close();
    }
  } finally {
    try { state.close(); } catch { /* already closed in the reopen assertion */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("committed project configuration remains authoritative until explicitly written", () => {
  const root = mkdtempSync(join(tmpdir(), "aer-fa04-registry-"));
  try {
    const registry = new ProjectRegistry();
    const committed = registry.register({ rootDir: root, name: "Committed", goal: "Keep this goal", verify: ["node -e pass"] });
    const reopened = registry.register({ rootDir: root, name: "Transient", goal: "Do not persist", verify: ["node -e fail"] });
    assert.equal(reopened.projectId, committed.projectId);
    assert.equal(reopened.name, "Committed");
    assert.equal(reopened.goal, "Keep this goal");
    assert.deepEqual(reopened.config.verify, ["node -e pass"]);

    const updated = registry.register({ rootDir: root, name: "Updated", goal: "New goal", writeConfig: true });
    assert.equal(updated.name, "Updated");
    assert.equal(updated.goal, "New goal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
