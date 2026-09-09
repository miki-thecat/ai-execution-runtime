import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexAgentExecutor,
  CodexJsonlParser,
  createOperationContext,
  createRunId,
  createTaskId,
  createTraceId,
  ProjectRegistry,
  SqliteStateStore,
  TaskManager,
} from "../src/index.ts";

function fixture(prefix: string): { readonly root: string; readonly runtime: string; readonly executable: string } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-project-`));
  const runtime = mkdtempSync(join(tmpdir(), `${prefix}-runtime-`));
  const executable = join(runtime, "codex-fixture");
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 0.99.0'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') { console.log('--json --sandbox --ask-for-approval --ignore-user-config --ignore-rules --color --ephemeral --skip-git-repo-check --config'); process.exit(0); }
if (args[0] === 'app-server') process.exit(1);
if (args.includes('--ignore-user-config') && args.includes('--ignore-rules') && args.includes('--ask-for-approval') && args.includes('--sandbox')) {
  const output = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  output({ type: 'thread.started', thread_id: 'thread-fixture' });
  output({ type: 'item.completed', item: { type: 'agent_message', text: process.env.GH_TOKEN ? 'secret-visible' : (process.env.AER_REQUIRED_ORDINARY || 'missing') } });
  output({ type: 'mystery.future_event', value: 1 });
  if (process.env.FAKE_CODEX_MODE === 'incomplete') process.exit(0);
  if (process.env.FAKE_CODEX_MODE === 'contradictory') { output({ type: 'turn.completed' }); output({ type: 'turn.failed' }); process.exit(0); }
  if (process.env.FAKE_CODEX_MODE === 'cancel') { setTimeout(() => {}, 10_000); return; }
  output({ type: 'turn.completed', turn_id: 'turn-fixture', usage: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 1 } });
  process.exit(process.env.FAKE_CODEX_MODE === 'failure' ? 2 : 0);
}
process.exit(2);
`);
  chmodSync(executable, 0o700);
  return { root, runtime, executable };
}

function context(projectId: import("../src/core/index.ts").ProjectId, taskId: import("../src/core/index.ts").TaskId, runId: import("../src/core/index.ts").RunId) {
  return createOperationContext({ traceId: createTraceId(), runId, taskId, projectId });
}

test("Codex JSONL parsing is chunk-safe and records unknown events", () => {
  const source = [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "item.started", item: { id: "command-1", type: "command_execution" } }),
    JSON.stringify({ type: "item.completed", item: { id: "command-1", type: "command_execution" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
    JSON.stringify({ type: "unknown.future", value: "ignored" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }),
  ].join("\n");
  const parser = new CodexJsonlParser();
  for (const character of source) parser.push(character);
  const split = parser.finish();
  const whole = new CodexJsonlParser();
  whole.push(source);
  assert.deepEqual(split, whole.finish());
  assert.equal(split.threadId, "t");
  assert.equal(split.output, "hello");
  assert.equal(split.commandCount, 1);
  assert.deepEqual(split.unknownEventTypes, ["unknown.future"]);
  assert.equal(split.terminalState, "completed");
});

test("Codex adapter owns bounded agent lifecycle and least-privilege child posture", async () => {
  const { root, runtime, executable } = fixture("aer-agent");
  const priorToken = process.env.GH_TOKEN;
  const priorOrdinary = process.env.AER_REQUIRED_ORDINARY;
  process.env.GH_TOKEN = "secret-sentinel";
  process.env.AER_REQUIRED_ORDINARY = "ordinary-value";
  const state = new SqliteStateStore(join(runtime, "aer.db"));
  try {
    const registry = new ProjectRegistry({ state });
    const project = registry.register({ rootDir: root, name: "agent fixture" });
    const tasks = new TaskManager({ state });
    const task = tasks.create({ projectId: project.projectId, title: "bounded task" });
    const executor = new CodexAgentExecutor({
      executable,
      registry,
      state,
      tasks,
      maxOutputBytes: 100,
    });
    const capabilities = await executor.capabilities();
    assert.equal(capabilities.compatible, true);
    assert.equal(capabilities.installedVersion, "0.99.0");
    assert.equal(capabilities.appServer, "unsupported");
    assert.deepEqual(capabilities.requiredIsolation, ["ignore-user-config", "ignore-rules"]);
    const result = await executor.run({ taskId: task.taskId, projectId: project.projectId, runId: task.runId, prompt: "say hello" }, context(project.projectId, task.taskId, task.runId));
    assert.equal(result.status, "completed");
    assert.equal(result.output, "ordinary-value");
    assert.equal(result.metrics.usage?.inputTokens, 4);
    assert.equal(result.capabilityPosture.apps, "suppressed");
    assert.equal(result.environment.withheld.some((entry) => entry.key === "GH_TOKEN"), true);
    assert.equal(JSON.stringify(result.environment).includes("secret-sentinel"), false);
    const durable = state.getEntity("agent_runs", result.agentRunId);
    assert.equal(durable?.projectId, project.projectId);
    assert.equal(durable?.taskId, task.taskId);
    assert.equal(durable?.runId, task.runId);
    assert.equal(JSON.stringify(durable).includes("ordinary-value"), false);
    assert.equal(state.listEvents({ runId: task.runId }).filter((event) => event.type.startsWith("agent.")).length, 2);
    assert.equal(tasks.get(task.taskId)?.status, "completed");
  } finally {
    if (priorToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorToken;
    if (priorOrdinary === undefined) delete process.env.AER_REQUIRED_ORDINARY;
    else process.env.AER_REQUIRED_ORDINARY = priorOrdinary;
    state.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Codex exit-zero incomplete and contradictory states are not success", async () => {
  const { root, runtime, executable } = fixture("aer-agent-terminal");
  const state = new SqliteStateStore(join(runtime, "aer.db"));
  try {
    const registry = new ProjectRegistry({ state });
    const project = registry.register({ rootDir: root });
    const create = async (mode: string) => {
      const task = new TaskManager({ state }).create({ projectId: project.projectId, title: mode, metadata: { mode } });
      const executor = new CodexAgentExecutor({ executable, registry, state, environment: { variables: { FAKE_CODEX_MODE: mode } } });
      return executor.run({ taskId: task.taskId, projectId: project.projectId, runId: task.runId, prompt: mode }, context(project.projectId, task.taskId, task.runId));
    };
    const incomplete = await create("incomplete");
    assert.equal(incomplete.status, "unknown");
    assert.equal(incomplete.error?.code, "AGENT_TERMINAL_STATE_INCOMPLETE");
    const contradictory = await create("contradictory");
    assert.equal(contradictory.status, "unknown");
    assert.equal(contradictory.error?.code, "AGENT_STRUCTURED_STATE_CONTRADICTORY");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Codex cancellation closes the worker stdin and remains truthful", async () => {
  const { root, runtime, executable } = fixture("aer-agent-cancel");
  const state = new SqliteStateStore(join(runtime, "aer.db"));
  try {
    const registry = new ProjectRegistry({ state });
    const project = registry.register({ rootDir: root });
    const task = new TaskManager({ state }).create({ projectId: project.projectId, title: "cancel" });
    const executor = new CodexAgentExecutor({ executable, registry, state, cancelGraceMs: 10, environment: { variables: { FAKE_CODEX_MODE: "cancel" } } });
    const runPromise = executor.run({ taskId: task.taskId, projectId: project.projectId, runId: task.runId, prompt: "cancel" }, context(project.projectId, task.taskId, task.runId));
    let active;
    for (let attempt = 0; attempt < 40 && active === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      active = state.listEntities("agent_runs", { projectId: project.projectId, status: "running" })[0];
    }
    assert.ok(active);
    await executor.cancel(active.id);
    const result = await runPromise;
    assert.equal(result.status, "cancelled");
    assert.equal(result.metrics.cancellationRequested, true);
    assert.equal(result.effectState, "unknown");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
