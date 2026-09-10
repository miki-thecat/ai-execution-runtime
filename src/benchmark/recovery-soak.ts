import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { registerMcpOperations } from "../mcp/index.ts";
import { AERDaemon, DEFAULT_AER_RUNTIME_DIRECTORY, DEFAULT_AER_OWNER_LOCK_NAME } from "../server/index.ts";
import { createSemanticOperationEnvelope, type SemanticOperationEnvelope } from "../remote/index.ts";
import { createRuntimeError, permissiveEffectPolicy } from "../core/index.ts";
import { SqliteStateStore } from "../state/index.ts";
import { TaskManager } from "../tasks/index.ts";
import type { ProjectResume } from "../project/index.ts";
import { summarizeRun } from "./compare.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Recovery soak: ${message}`);
}

/** Fixed six writes, two reopens; no model, external services, or timed soak loop.
 * Latency covers semantic dispatch; bytes are UTF-8 result JSON, excluding transport.
 * Retries count explicit receipt replays plus runtime-reported retries. UNKNOWN
 * transitions count durable run/task/agent terminal events (not operation mirrors).
 */
export async function runRecoverySoak() {
  const root = mkdtempSync(join(tmpdir(), "aer-soak-"));
  const endpoint = join(root, "daemon.sock");
  const dbPath = join(root, "aer.db");
  let state = new SqliteStateStore(dbPath);
  let daemon = registerMcpOperations(new AERDaemon({ state, dataRoot: root, endpoint, policy: permissiveEffectPolicy() }));
  const metrics = { attemptedOperations: 0, successfulOperations: 0, restarts: 0, recoveries: 0, unknownTransitions: 0, retries: 0, modelPolls: 0, totalLatencyMs: 0, maximumLatencyMs: 0, returnedBytes: 0, operatorInterventions: 0 };
  let socket: { status: "passed" | "skipped"; reason?: string } = { status: "passed" };
  const runIds = new Set<string>();
  try {
    writeFileSync(join(root, "notes.txt"), "seed\n");
    const project = daemon.registerProject({ rootDir: root, name: "Bounded recovery soak" });
    let client: Pick<AERDaemon, "execute"> = daemon;
    const execute = async (envelope: SemanticOperationEnvelope, replay = false) => {
      metrics.attemptedOperations++;
      if (replay) metrics.retries++;
      const start = performance.now();
      const result = await client.execute(envelope);
      const elapsed = performance.now() - start;
      metrics.totalLatencyMs += elapsed;
      metrics.maximumLatencyMs = Math.max(metrics.maximumLatencyMs, elapsed);
      metrics.returnedBytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
      runIds.add(result.meta.runId);
      if (result.ok) metrics.successfulOperations++;
      check(result.ok, `${envelope.operation} failed: ${result.ok ? "" : result.error.code}`);
      if (replay) check(result.receipt?.replayed, "write was executed instead of replayed");
      return result;
    };
    const envelope = (operation: string, input: unknown, idempotencyKey?: string) => createSemanticOperationEnvelope({ operation, input, projectId: project.projectId, actor: "model", ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    const writes: SemanticOperationEnvelope[] = [];
    let content = "seed\n";
    const writeBatch = async () => {
      for (let index = 0; index < 3; index++) {
        const read = await execute(envelope("file.read", { path: "notes.txt" }));
        content += `effect-${writes.length}\n`;
        const patch = envelope("file.patch", { path: "notes.txt", expectedHash: (read.data as { contentHash: string }).contentHash, content }, `soak-${writes.length}`);
        await execute(patch);
        writes.push(patch);
        await execute(patch, true);
      }
    };
    await writeBatch();

    // Same durable boundary as recovery.test.ts: terminal UNKNOWN parent with
    // delegated children still RUNNING, without executing an ambiguous effect.
    const run = daemon.tracer.startRun({ projectId: project.projectId, actor: "runtime" });
    const tasks = new TaskManager({ state, tracer: daemon.tracer });
    const task = tasks.create({ title: "Interrupted delegation", projectId: project.projectId, runId: run.runId, traceId: run.traceId });
    tasks.start(task.taskId);
    const agentId = `agent_${run.runId}`;
    state.saveEntity({ kind: "agent_runs", id: agentId, projectId: project.projectId, runId: run.runId, taskId: task.taskId, status: "running", data: { traceId: run.traceId, executor: "codex", terminalState: "incomplete", effectState: "none", providerThreadId: "thread-preserved" } });
    const error = createRuntimeError({ code: "OPERATION_TIMEOUT", message: "Outer outcome uncertain", effect: "unknown", retryable: false });
    run.operation({ operation: "agent.delegate", effectClass: "workspace_write" }).unknown(error);
    run.unknown(error);
    const parent = JSON.stringify(state.getEntity("runs", run.runId));
    check(state.getEntity("tasks", task.taskId)?.status === "running", "missing interrupted task");
    check(state.getEntity("agent_runs", agentId)?.status === "running", "missing interrupted agent");
    try { await daemon.start(); }
    catch (cause) {
      if ((cause as { code?: string }).code !== "EPERM") throw cause;
      socket = { status: "skipped", reason: "EPERM: execution environment forbids Unix-domain sockets" };
    }
    let reconciledEvents: string | undefined;
    for (let cycle = 0; cycle < 2; cycle++) {
      await daemon.stop();
      state.close();
      if (cycle === 0 && socket.status === "passed") {
        // Leave an actual dead daemon owner and socket. Existing start() must
        // prove both stale and recover them; no manual deletion or transport shim.
        const child = spawnSync(execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
          import { AERDaemon } from ${JSON.stringify(new URL("../server/index.ts", import.meta.url).href)};
          const daemon = new AERDaemon({ dataRoot: ${JSON.stringify(root)}, endpoint: ${JSON.stringify(endpoint)} });
          try { await daemon.start(); }
          catch (error) { if (error.code === 'EPERM') { console.log('SOCKET_EPERM'); process.exit(0); } throw error; }
          process.kill(process.pid, 'SIGKILL');
        `], { encoding: "utf8", timeout: 10_000 });
        check(!child.error, `daemon child failed: ${child.error?.message}`);
        if (String(child.stdout).trim() === "SOCKET_EPERM") socket = { status: "skipped", reason: "EPERM: execution environment forbids Unix-domain sockets" };
        else check(child.status === null && existsSync(endpoint) && existsSync(join(root, DEFAULT_AER_RUNTIME_DIRECTORY, DEFAULT_AER_OWNER_LOCK_NAME)), `daemon did not leave stale socket: ${String(child.stderr)}`);
      }
      state = new SqliteStateStore(dbPath);
      daemon = registerMcpOperations(new AERDaemon({ state, dataRoot: root, endpoint, policy: permissiveEffectPolicy() }));
      metrics.restarts++;
      if (socket.status === "passed") {
        await daemon.start();
        client = daemon.client();
      } else client = daemon; // Existing in-process dispatch; socket assertion alone is skipped.
      const resumed = await execute(envelope("project.resume", { eventLimit: 50, itemLimit: 50 }));
      const resume = resumed.data as ProjectResume;
      check(!resume.activeTasks.some((item) => item.taskId === task.taskId), "leaked active task");
      check(resume.unknownEffects.some((item) => item.source === `agent_runs:${agentId}`), "resume lost UNKNOWN evidence");
      check(JSON.stringify(state.getEntity("runs", run.runId)) === parent, "parent UNKNOWN changed");
      for (const [kind, id] of [["tasks", task.taskId], ["agent_runs", agentId]] as const) {
        const entity = state.getEntity(kind, id);
        check(entity?.status === "unknown" && typeof entity.data?.completedAt === "string", "child was not reconciled");
      }
      check(state.getEntity("agent_runs", agentId)?.data?.providerThreadId === "thread-preserved", "lost provider evidence");
      const events = state.listEvents({ runId: run.runId });
      for (const type of ["task.unknown", "agent.failed"] as const) check(events.filter((event) => event.type === type && event.status === "unknown" && event.effectState === "unknown").length === 1, "missing or duplicate reconciliation event");
      if (reconciledEvents !== undefined) check(JSON.stringify(events) === reconciledEvents, "reopen repeated reconciliation");
      reconciledEvents = JSON.stringify(events);
      metrics.recoveries++;
      for (const patch of writes) await execute(patch, true);
      if (cycle === 0) await writeBatch();
    }
    check(new TextDecoder().decode(readFileSync(join(root, "notes.txt"))) === content, "duplicate or missing file effects");
    const durableEffects = state.listEntities("changesets").length;
    check(durableEffects === 6 && state.listEntities("effect_receipts").length === 6, "duplicate durable effects/receipts");
    check(state.listEntities("agent_runs").length === 1 && state.listEntities("tasks").length === 1, "ambiguous delegation was re-executed");
    const events = state.listEvents({ limit: 10_000, order: "asc" });
    check(events.filter((event) => event.type === "remote.requested").length === metrics.attemptedOperations, "missing requested observability");
    check(events.filter((event) => event.type === "remote.completed").length === metrics.successfulOperations, "missing completed observability");
    metrics.unknownTransitions = events.filter((event) => ["run.unknown", "task.unknown", "agent.failed"].includes(event.type) && event.status === "unknown").length;
    for (const id of runIds) {
      const summary = summarizeRun(id, events.filter((event) => event.runId === id), state);
      metrics.modelPolls += summary.modelPolling;
      metrics.retries += summary.retries;
    }
    check(metrics.modelPolls === 0 && metrics.operatorInterventions === 0, "unexpected polling/intervention");
    return { scenario: "beta-03-bounded-recovery", metrics, socket, durableEffects, unknownChildren: 2, cleanup: "completed" };
  } finally {
    await daemon.stop();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
}
