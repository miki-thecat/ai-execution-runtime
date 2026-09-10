import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeError } from "../src/core/index.ts";
import { Tracer } from "../src/observability/index.ts";
import { ProjectRuntime } from "../src/project/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";
import { TaskManager } from "../src/tasks/index.ts";

test("reopen reconciles running delegated children only for a terminal unknown parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "aer-recovery-"));
  const dbPath = join(root, "state.db");
  let state = new SqliteStateStore(dbPath);
  try {
    const runtime = new ProjectRuntime({ state });
    const project = runtime.register({ rootDir: root, name: "Recovery" });
    const tracer = new Tracer({ sink: state });
    const tasks = new TaskManager({ state, tracer });
    const seed = () => {
      const run = tracer.startRun({ projectId: project.projectId, actor: "runtime" });
      const task = tasks.create({ title: "Delegated work", projectId: project.projectId, runId: run.runId, traceId: run.traceId });
      tasks.start(task.taskId);
      const agentId = `agent_${run.runId}`;
      state.saveEntity({ kind: "agent_runs", id: agentId, projectId: project.projectId, runId: run.runId, taskId: task.taskId, status: "running", data: { traceId: run.traceId, executor: "codex", provider: "openai", terminalState: "incomplete", effectState: "none", providerThreadId: "thread-preserved" } });
      return { run, task, agentId };
    };
    const stale = seed();
    const live = seed();
    const error = createRuntimeError({ code: "OPERATION_TIMEOUT", message: "Outer operation outcome uncertain", effect: "unknown", retryable: false });
    stale.run.operation({ operation: "agent.delegate", effectClass: "workspace_write" }).unknown(error);
    stale.run.unknown(error);
    const parent = state.getEntity("runs", stale.run.runId);
    assert.equal(parent?.status, "unknown");
    assert.equal(state.getEntity("tasks", stale.task.taskId)?.status, "running");
    assert.equal(state.getEntity("agent_runs", stale.agentId)?.status, "running");
    const liveTask = state.getEntity("tasks", live.task.taskId);
    const liveAgent = state.getEntity("agent_runs", live.agentId);
    state.close();
    state = new SqliteStateStore(dbPath);
    const reopened = new ProjectRuntime({ state });
    for (const [kind, id] of [["tasks", stale.task.taskId], ["agent_runs", stale.agentId]] as const) {
      const child = state.getEntity(kind, id);
      assert.equal(child?.status, "unknown");
      assert.equal(child?.projectId, project.projectId);
      assert.equal(child?.runId, stale.run.runId);
      assert.equal(typeof child?.data?.completedAt, "string");
    }
    assert.deepEqual(state.getEntity("runs", stale.run.runId), parent);
    assert.deepEqual(state.getEntity("tasks", live.task.taskId), liveTask);
    assert.deepEqual(state.getEntity("agent_runs", live.agentId), liveAgent);
    assert.equal(state.getEntity("agent_runs", stale.agentId)?.data?.providerThreadId, "thread-preserved");
    const events = state.listEvents({ runId: stale.run.runId });
    for (const type of ["task.unknown", "agent.failed"] as const) {
      const event = events.find((candidate) => candidate.type === type);
      assert.equal(event?.status, "unknown");
      assert.equal(event?.effectState, "unknown");
      assert.equal(event?.projectId, project.projectId);
    }
    assert.equal(events.some((event) => event.status === "failed"), false);
    const resumed = await reopened.resume(project);
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.data.activeTasks.some((task) => task.taskId === stale.task.taskId), false);
    assert.equal(resumed.data.activeTasks.some((task) => task.taskId === live.task.taskId), true);
    assert.equal(resumed.data.lastAgent?.id, stale.agentId);
    assert.equal(resumed.data.lastAgent?.status, "unknown");
    assert.ok(resumed.data.unknownEffects.some((item) => item.source === `agent_runs:${stale.agentId}`));
    state.close();
    state = new SqliteStateStore(dbPath);
    new ProjectRuntime({ state });
    assert.deepEqual(state.listEvents({ runId: stale.run.runId }), events);
    assert.equal(state.listEntities("agent_runs").length, 2);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
