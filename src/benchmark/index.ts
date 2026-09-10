import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { measureMcpPresentation, type McpPresentationMeasurements } from "../mcp/presentation.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd as processCwd, execPath } from "node:process";
import { AERDaemon, type DaemonOperationResult } from "../server/index.ts";
import { createMcpFactory, createMcpHandler, registerMcpOperations } from "../mcp/index.ts";
import { createSemanticOperationEnvelope } from "../remote/index.ts";
import { permissiveEffectPolicy } from "../core/index.ts";
import { CodexAgentExecutor } from "../agents/index.ts";
import { GitHubProvider, type GitHubCommandResult, type GitHubCommandRunner } from "../github/index.ts";
import { TaskManager } from "../tasks/index.ts";
import { SqliteStateStore } from "../state/index.ts";
import { summarizeRun, type RunComparison, type RunMetricSummary } from "./compare.ts";

export * from "./compare.ts";

export type ScenarioStepStatus = "passed" | "skipped" | "failed";

export interface ScenarioStep {
  readonly name: string;
  readonly status: ScenarioStepStatus;
  readonly operation?: string;
  readonly runId?: string;
  readonly summary?: string;
}

export interface DogfoodCase {
  readonly name: string;
  readonly aer: {
    readonly modelFacingOperations: number;
    readonly modelPolling: number;
    readonly durationMs: number;
    readonly status: string;
  };
  readonly rdc: {
    readonly modelFacingOperations: number;
    readonly modelPolling: number;
    readonly durationMs: number;
    readonly status: string;
  };
  readonly modelCallReduction: number;
  readonly source: "scripted-first-baseline";
}

export interface FullAlphaRunInspection {
  readonly runId: string;
  readonly timeline: readonly Record<string, unknown>[];
  readonly metrics: RunMetricSummary;
}

export interface FullAlphaScenarioResult {
  readonly ok: boolean;
  readonly scenario: "full-alpha";
  readonly projectId: string;
  readonly steps: readonly ScenarioStep[];
  readonly runs: readonly RunMetricSummary[];
  readonly inspection: FullAlphaRunInspection;
  readonly comparison: RunComparison;
  readonly dogfood: readonly DogfoodCase[];
  readonly mcp: {
    /** Repeatable offline measurements from actual HTTP MCP tool results. */
    readonly presentation: readonly (McpPresentationMeasurements & { readonly operation: string; readonly duplicatedJsonPresentationBytes: number })[];
    readonly presentationScope: "UTF-8 CallToolResult JSON; excludes JSON-RPC/transport framing; tokens are byte/4 proxies";
    readonly protocol: string;
    readonly listedTools: number;
    readonly listPassed: boolean;
    readonly callPassed: boolean;
    readonly inspector: "pass" | "unavailable";
  };
  readonly plugin: {
    readonly status: "pass" | "failed";
    readonly deterministic: boolean;
    readonly manifestDigest: string;
    readonly toolsDigest: string;
  };
  readonly tunnel: {
    readonly status: "SKIPPED";
    readonly client: "available" | "unavailable";
    readonly reason: string;
  };
  readonly cleanup: "completed";
}

interface FixtureRepository {
  readonly name: string;
  readonly nameWithOwner: string;
  readonly url: string;
  readonly defaultBranchRef: { readonly name: string };
  readonly owner: { readonly login: string };
}

const FIXTURE_REPOSITORY: FixtureRepository = {
  name: "full-alpha-fixture",
  nameWithOwner: "aer/full-alpha-fixture",
  url: "https://github.com/aer/full-alpha-fixture",
  defaultBranchRef: { name: "main" },
  owner: { login: "aer" },
};

const FIXTURE_PR = {
  number: 7,
  title: "Full Alpha fixture",
  state: "OPEN",
  url: "https://github.com/aer/full-alpha-fixture/pull/7",
  isDraft: false,
  headRefName: "main",
  headRefOid: "fixture-head",
  baseRefName: "main",
  baseRefOid: "fixture-base",
  statusCheckRollup: [{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
  reviewDecision: "APPROVED",
  reviews: [{ author: { login: "fixture-reviewer" }, state: "APPROVED" }],
};

function jsonResult(value: unknown): GitHubCommandResult {
  const stdout = JSON.stringify(value);
  return { stdout, stderr: "", exitCode: 0, rawOutputBytes: new TextEncoder().encode(stdout).byteLength * 2, returnedOutputBytes: new TextEncoder().encode(stdout).byteLength };
}

/** Offline GitHub command fixture. It exercises the semantic provider without an account or network. */
class FixtureGitHubRunner implements GitHubCommandRunner {
  private waitPoll = 0;

  async runExecutable(command: { readonly executable: string; readonly args?: readonly string[] }): Promise<GitHubCommandResult> {
    const args = [...(command.args ?? [])];
    if (args[0] === "repo" && args[1] === "view") return jsonResult(FIXTURE_REPOSITORY);
    if (args[0] === "pr" && args[1] === "view") return jsonResult(FIXTURE_PR);
    if (args[0] === "pr" && args[1] === "checks") {
      this.waitPoll += 1;
      return jsonResult(this.waitPoll === 1 ? [{ name: "verify", state: "IN_PROGRESS" }] : [{ name: "verify", state: "COMPLETED", conclusion: "SUCCESS" }]);
    }
    if (args[0] === "issue" && args[1] === "view") return jsonResult({ number: 12, title: "Full Alpha", state: "OPEN", url: "https://github.com/aer/full-alpha-fixture/issues/12", labels: [{ name: "alpha" }], assignees: [] });
    if (args[0] === "api" && args[1]?.includes("dependencies/blocked_by")) return jsonResult([{ number: 11, state: "closed" }]);
    if (args[0] === "api" && args[1]?.includes("dependencies/blocking")) return jsonResult([]);
    if (args[0] === "branch" && args[1] === "--show-current") return { stdout: "main\n", stderr: "", exitCode: 0 };
    if (args[0] === "rev-parse") return { stdout: "fixture-head\n", stderr: "", exitCode: 0 };
    if (args[0] === "--version") return { stdout: "gh version 2.60.0\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: `fixture miss: ${command.executable} ${args.join(" ")}`, exitCode: 1 };
  }

  async runShell(): Promise<GitHubCommandResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

function writeCodexFixture(directory: string): string {
  const executable = join(directory, "codex-fixture");
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 0.99.0'); process.exit(0); }
if (args[0] === 'features') { console.log('apps stable false\\nbrowser_use stable false\\nbrowser_use_external stable false\\nbrowser_use_full_cdp_access stable false\\ncomputer_use stable false\\nhooks stable false\\nimage_generation stable false\\nmulti_agent stable false\\nplugin_sharing stable false\\nplugins stable false\\nremote_plugin stable false\\nskill_mcp_dependency_install stable false\\nskill_search stable false'); process.exit(0); }
if (args[0] === 'sandbox') process.exit(0);
if (args[0] === 'exec' && args[1] === '--help') { console.log('--json --sandbox --disable --config --ask-for-approval --ignore-user-config --ignore-rules --color --ephemeral --skip-git-repo-check'); process.exit(0); }
if (args[0] === 'app-server') process.exit(1);
if (args[0] === 'exec') {
  const output = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  output({ type: 'thread.started', thread_id: 'full-alpha-thread' });
  output({ type: 'item.completed', item: { type: 'agent_message', text: 'delegated fixture complete' } });
  output({ type: 'turn.completed', turn_id: 'full-alpha-turn', usage: { input_tokens: 8, output_tokens: 4, cached_input_tokens: 2 } });
  process.exit(0);
}
process.exit(2);
`);
  chmodSync(executable, 0o700);
  return executable;
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed`);
}

function digest(value: string): string {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function rpcRequest(handler: ReturnType<typeof createMcpHandler>, id: number, method: string, params: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> {
  return handler(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })).then(async (response) => JSON.parse(await response.text()) as Record<string, unknown>);
}

function step(name: string, operation: string, result: DaemonOperationResult<unknown>): ScenarioStep {
  return {
    name,
    operation,
    status: result.ok ? "passed" : "failed",
    runId: result.meta.runId,
    summary: result.ok ? result.meta.summary ?? "completed" : result.error.code,
  };
}

function requireSuccess<T>(result: DaemonOperationResult<T>, name: string): Extract<DaemonOperationResult<T>, { readonly ok: true }> {
  if (!result.ok) throw new Error(`${name}: ${result.error.code}`);
  return result;
}

function combinedMetric(runId: string, metrics: readonly RunMetricSummary[]): RunMetricSummary {
  const first = metrics[0];
  if (first === undefined) throw new Error("Cannot combine an empty benchmark metric set");
  const completed = metrics.every((metric) => metric.status === "completed");
  return {
    ...first,
    runId,
    status: completed ? "completed" : "failed",
    durationMs: metrics.reduce((total, metric) => total + metric.durationMs, 0),
    modelFacingOperations: metrics.reduce((total, metric) => total + metric.modelFacingOperations, 0),
    modelOperations: metrics.reduce((total, metric) => total + metric.modelOperations, 0),
    internalCalls: metrics.reduce((total, metric) => total + metric.internalCalls, 0),
    pollCountModel: metrics.reduce((total, metric) => total + metric.pollCountModel, 0),
    modelPolling: metrics.reduce((total, metric) => total + metric.modelPolling, 0),
    pollCountInternal: metrics.reduce((total, metric) => total + metric.pollCountInternal, 0),
    internalPolling: metrics.reduce((total, metric) => total + metric.internalPolling, 0),
    rawOutputBytes: metrics.reduce((total, metric) => total + metric.rawOutputBytes, 0),
    rawBytes: metrics.reduce((total, metric) => total + metric.rawBytes, 0),
    returnedOutputBytes: metrics.reduce((total, metric) => total + metric.returnedOutputBytes, 0),
    returnedBytes: metrics.reduce((total, metric) => total + metric.returnedBytes, 0),
    compressionRatio: metrics.reduce((total, metric) => total + metric.rawOutputBytes, 0) / Math.max(metrics.reduce((total, metric) => total + metric.returnedOutputBytes, 0), 1),
    retries: metrics.reduce((total, metric) => total + metric.retries, 0),
    filesChanged: metrics.reduce((total, metric) => total + metric.filesChanged, 0),
  };
}

function rdcBaseline(actual: Readonly<Record<string, RunMetricSummary>>): readonly DogfoodCase[] {
  const cases = [
    ["repo-inspection", 4, 0],
    ["github-state", 6, 0],
    ["long-wait", 4, 3],
    ["small-patch-verify", 5, 0],
    ["fresh-client-resume", 4, 0],
    ["daemon-route", 3, 0],
    ["mcp-route", 3, 0],
  ] as const;
  return cases.map(([name, rdcCalls, rdcPolling]) => {
    const metric = actual[name];
    const aerCalls = metric?.modelFacingOperations ?? 0;
    const aerStatus = metric?.status ?? "unknown";
    const aerDuration = metric?.durationMs ?? 0;
    return {
      name,
      aer: { modelFacingOperations: aerCalls, modelPolling: metric?.modelPolling ?? 0, durationMs: aerDuration, status: aerStatus },
      rdc: { modelFacingOperations: rdcCalls, modelPolling: rdcPolling, durationMs: 0, status: "scripted-baseline" },
      modelCallReduction: (rdcCalls - aerCalls) / Math.max(rdcCalls, 1),
      source: "scripted-first-baseline",
    };
  });
}

function tunnelStatus(): FullAlphaScenarioResult["tunnel"] {
  const probe = spawnSync("tunnel-client", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000 });
  return {
    status: "SKIPPED",
    client: probe.status === 0 ? "available" : "unavailable",
    reason: probe.status === 0 ? "client detected but account authorization was not verified" : "secure MCP Tunnel client is unavailable",
  };
}

/**
 * Run the complete, deterministic Full Alpha walking skeleton. External GitHub
 * and Codex accounts are intentionally not required; their official adapters
 * are exercised through bounded provider/worker seams.
 */
export async function runFullAlphaScenario(): Promise<FullAlphaScenarioResult> {
  const projectRoot = mkdtempSync(join(tmpdir(), "aer-full-alpha-project-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "aer-full-alpha-runtime-"));
  const steps: ScenarioStep[] = [];
  const runIds: string[] = [];
  let freshMetric: RunMetricSummary | undefined;
  let daemon: AERDaemon | undefined;
  let daemonStarted = false;
  let endpoint: string | undefined;
  let daemonStartError: string | undefined;
  try {
    writeFileSync(join(projectRoot, "notes.txt"), "alpha\nneedle one\nneedle two\n");
    git(projectRoot, ["init", "-q"]);
    git(projectRoot, ["branch", "-M", "main"]);
    git(projectRoot, ["config", "user.email", "aer@example.test"]);
    git(projectRoot, ["config", "user.name", "AER Full Alpha"]);

    // Keep the socket name relative and short so the scenario also works in
    // CI runners whose workspace path is already close to Unix's path limit.
    endpoint = `.aer-full-alpha-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.sock`;
    daemon = new AERDaemon({ dataRoot: runtimeRoot, endpoint, policy: permissiveEffectPolicy() });
    const project = daemon.registerProject({
      rootDir: projectRoot,
      name: "Full Alpha fixture",
      goal: "Exercise the complete walking skeleton",
      verify: [{ name: "verify", executable: execPath, args: ["-e", "process.stdout.write('verify-ok')"] }],
    });
    git(projectRoot, ["add", ".aer/project.json", "notes.txt"]);
    git(projectRoot, ["commit", "-qm", "fixture baseline"]);
    steps.push({ name: "project.init", status: "passed", summary: project.projectId });

    const github = new GitHubProvider({ direct: daemon.direct, tracer: daemon.tracer, runner: new FixtureGitHubRunner() });
    const tasks = new TaskManager({ state: daemon.state, tracer: daemon.tracer });
    const agent = new CodexAgentExecutor({ executable: writeCodexFixture(runtimeRoot), state: daemon.state, tracer: daemon.tracer, artifacts: daemon.artifacts, registry: daemon.projects, tasks, maxOutputBytes: 256 });
    registerMcpOperations(daemon, { github, agent });
    try {
      await daemon.start();
      daemonStarted = true;
    } catch (error) {
      // The repository's existing daemon tests use the same honest skip in
      // restricted runners where Unix-domain listeners are disabled.
      daemonStartError = error instanceof Error ? error.message : "local daemon listener unavailable";
    }

    const execute = async (operation: string, input: unknown, route: "local" | "daemon" = "daemon"): Promise<DaemonOperationResult<unknown>> => {
      const envelope = createSemanticOperationEnvelope({ operation, input, projectId: project.projectId, actor: "model" });
      const result = route === "local" && daemonStarted ? await daemon!.client().execute(envelope) : await daemon!.execute(envelope);
      runIds.push(result.meta.runId);
      return result;
    };

    const resumed = await execute("project.resume", { eventLimit: 20, itemLimit: 20 });
    requireSuccess(resumed, "project.resume");
    steps.push(step("project.resume", "project.resume", resumed));
    const inspected = await execute("project.inspect", {});
    requireSuccess(inspected, "project.inspect");
    steps.push(step("project.inspect", "project.inspect", inspected));

    const direct = await execute("shell.run", { command: "printf 'direct-alpha-output'", maxOutputBytes: 8 });
    requireSuccess(direct, "shell.run");
    steps.push(step("direct command + bounded output/artifact", "shell.run", direct));
    const directData = direct.ok ? direct.data as { readonly artifactRefs?: readonly string[] } : {};
    const directRefs = directData.artifactRefs ?? [];
    const boundedEvidence = directRefs.every((ref) => daemon!.artifacts.has(ref as never, { projectId: project.projectId }) && daemon!.artifacts.read(ref as never, { projectId: project.projectId }).byteLength <= daemon!.budgets.maxArtifactBytes);
    if (!boundedEvidence) throw new Error("bounded command evidence could not be reread");
    const artifactRef = directRefs[0];
    if (artifactRef === undefined) throw new Error("bounded command did not produce an evidence artifact");
    const artifactRead = await execute("artifact.read", { ref: artifactRef, maxBytes: 8 });
    requireSuccess(artifactRead, "artifact.read");
    steps.push(step("bounded local evidence/artifact", "artifact.read", artifactRead));
    const read = await execute("file.read", { path: "notes.txt", maxBytes: 4096 });
    requireSuccess(read, "file.read");
    steps.push(step("file.read", "file.read", read));
    const searched = await execute("file.search", { query: "needle", path: "notes.txt" });
    requireSuccess(searched, "file.search");
    steps.push(step("file.search", "file.search", searched));
    const readData = read.ok ? read.data as { readonly contentHash: string } : undefined;
    const patched = await execute("file.patch", { path: "notes.txt", expectedHash: readData?.contentHash, content: "alpha\nneedle one\nneedle two\npatched\n" });
    requireSuccess(patched, "file.patch");
    steps.push(step("guarded patch + ChangeSet", "file.patch", patched));
    const verified = await execute("verify.run", {});
    requireSuccess(verified, "verify.run");
    steps.push(step("verification", "verify.run", verified));

    const snapshot = await execute("github.snapshot", { cwd: projectRoot, issueNumber: 12, includeWork: true, issueNumbers: [12] });
    requireSuccess(snapshot, "github.snapshot");
    const snapshotData = snapshot.ok ? snapshot.data as { readonly work?: { readonly blocked?: readonly number[] } } : {};
    if (snapshotData.work?.blocked?.includes(12) === true) throw new Error("closed GitHub predecessor was reported as an unresolved blocker");
    steps.push(step("github semantic snapshot", "github.snapshot", snapshot));
    const waited = await execute("github.wait", { cwd: projectRoot, pullRequest: 7, condition: "checks_terminal", intervalMs: 0, maxPolls: 3 });
    requireSuccess(waited, "github.wait");
    const waitData = waited.ok ? waited.data as { readonly pollCountModel?: number; readonly pollCountInternal?: number } : {};
    if (waitData.pollCountModel !== 0 || (waitData.pollCountInternal ?? 0) < 1) throw new Error("GitHub wait did not keep polling internal to AER");
    steps.push(step("github semantic wait", "github.wait", waited));
    const delegated = await execute("agent.run", { title: "bounded fixture delegation", prompt: "Report completion." });
    requireSuccess(delegated, "agent.run");
    steps.push(step("optional Codex delegation", "agent.run", delegated));

    const inspectedRunId = direct.meta.runId;
    const inspectedRun = await execute("run.inspect", { runId: inspectedRunId });
    const successfulInspection = requireSuccess(inspectedRun, "run.inspect");
    const inspectionData = successfulInspection.data as { readonly timeline?: readonly Record<string, unknown>[]; readonly metrics?: RunMetricSummary };
    const inspection: FullAlphaRunInspection = { runId: inspectedRunId, timeline: inspectionData.timeline ?? [], metrics: inspectionData.metrics ?? summarizeRun(inspectedRunId, daemon.state.listEvents({ runId: inspectedRunId as never, limit: 1_000, order: "asc" }), daemon.state) };
    steps.push(step("run.inspect timeline", "run.inspect", successfulInspection));

    const local = await execute("project.inspect", {}, "local");
    requireSuccess(local, "daemon local route");
    steps.push(daemonStarted
      ? step("daemon.local-route", "project.inspect", local)
      : { name: "daemon.local-route", operation: "project.inspect", status: "skipped", summary: daemonStartError ?? "local daemon listener unavailable" });

    const handler = createMcpHandler(createMcpFactory({ daemon }));
    const initialized = await rpcRequest(handler, 1, "initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "full-alpha-harness", version: "1" } });
    const listed = await rpcRequest(handler, 2, "tools/list");
    const called = await rpcRequest(handler, 3, "tools/call", { name: "project.inspect", arguments: { projectId: project.projectId } });
    const toolResult = initialized.result !== undefined && listed.result !== undefined && called.result !== undefined;
    const listedTools = listed.result !== null && typeof listed.result === "object" && Array.isArray((listed.result as Record<string, unknown>).tools) ? ((listed.result as Record<string, unknown>).tools as unknown[]).length : 0;
    if (!toolResult) throw new Error("MCP initialize/list/call failed");
    const mcpRunId = daemon.state.listEvents({ type: "remote.completed", limit: 1, order: "desc" })[0]?.runId;
    const presentation = [];
    const representativeCalls = [
      ["project.inspect", { projectId: project.projectId }],
      ["project.resume", { projectId: project.projectId }],
      ["file.search", { projectId: project.projectId, query: "needle", path: "notes.txt" }],
      ["github.wait", { projectId: project.projectId, cwd: projectRoot, pullRequest: 7, condition: "checks_terminal", intervalMs: 1, maxPolls: 3 }],
      ["run.inspect", { runId: searched.meta.runId }],
      ["run.compare", { runIds: [local.meta.runId, mcpRunId!] }],
    ] as const;
    for (const [operation, args] of representativeCalls) {
      const rpc = await rpcRequest(handler, 10 + presentation.length, "tools/call", { name: operation, arguments: args });
      const result = rpc.result as CallToolResult | undefined;
      if (result === undefined || result.isError || result.structuredContent?.data === undefined) throw new Error(`MCP benchmark failed: ${operation}`);
      const duplicated = { ...result, content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }] };
      presentation.push({ operation, ...measureMcpPresentation(result), duplicatedJsonPresentationBytes: measureMcpPresentation(duplicated).presentationBytes });
    }
    steps.push({ name: "MCP Inspector list/call", operation: "project.inspect", status: "passed", ...(mcpRunId === undefined ? {} : { runId: mcpRunId }), summary: `${listedTools} tools through the official SDK handler` });

    const compared = await execute("run.compare", { runIds: [...new Set([...runIds, ...(mcpRunId === undefined ? [] : [mcpRunId])])].slice(0, 20) });
    const successfulComparison = requireSuccess(compared, "run.compare");
    steps.push(step("run.compare hierarchy-aware metrics", "run.compare", successfulComparison));
    const comparison = successfulComparison.data as RunComparison;
    const freshRunIds = [...new Set(runIds)];
    if (mcpRunId !== undefined) freshRunIds.push(mcpRunId);
    const runs = freshRunIds.map((runId) => summarizeRun(runId, daemon!.state.listEvents({ runId: runId as never, limit: 1_000, order: "asc" }), daemon!.state));
    // Close the first runtime before reopening its durable database. This is
    // the same boundary a new client/runtime process observes after a chat
    // handoff, and avoids two in-process SQLite owners during the check.
    await daemon.stop();
    daemonStarted = false;
    if (daemon.state !== undefined) {
      try { daemon.state.close(); } catch { /* A started daemon already closed its owned state. */ }
    }
    const reopenedState = new SqliteStateStore(join(runtimeRoot, "aer.db"));
    try {
      const freshDaemon = new AERDaemon({ dataRoot: runtimeRoot, state: reopenedState, policy: permissiveEffectPolicy() });
      registerMcpOperations(freshDaemon);
      const freshRun = await freshDaemon.execute(createSemanticOperationEnvelope({ operation: "project.resume", input: { eventLimit: 20, itemLimit: 20 }, projectId: project.projectId, actor: "model" }));
      requireSuccess(freshRun, "fresh-client resume");
      steps.push(step("fresh-client resume", "project.resume", freshRun));
      freshMetric = summarizeRun(freshRun.meta.runId, reopenedState.listEvents({ runId: freshRun.meta.runId, limit: 1_000, order: "asc" }), reopenedState);
      runs.push(freshMetric);
    } finally {
      reopenedState.close();
    }
    const pluginManifest = new TextDecoder().decode(readFileSync(join(processCwd(), "plugin", "manifest.json")));
    const pluginTools = new TextDecoder().decode(readFileSync(join(processCwd(), "plugin", "tools.json")));
    const pluginManifestValue = JSON.parse(pluginManifest) as unknown;
    const pluginToolsValue = JSON.parse(pluginTools) as unknown;
    const plugin = { status: "pass" as const, deterministic: canonicalJson(pluginManifestValue) === canonicalJson(JSON.parse(pluginManifest)) && canonicalJson(pluginToolsValue) === canonicalJson(JSON.parse(pluginTools)), manifestDigest: digest(canonicalJson(pluginManifestValue)), toolsDigest: digest(canonicalJson(pluginToolsValue)) };
    const tunnel = tunnelStatus();
    const metricByRun = new Map(runs.map((metric) => [metric.runId, metric]));
    const actual: Record<string, RunMetricSummary> = {
      "repo-inspection": metricByRun.get(inspected.meta.runId)!,
      "github-state": metricByRun.get(snapshot.meta.runId)!,
      "long-wait": metricByRun.get(waited.meta.runId)!,
      "small-patch-verify": combinedMetric("patch+verify", [metricByRun.get(patched.meta.runId)!, metricByRun.get(verified.meta.runId)!]),
      "daemon-route": metricByRun.get(local.meta.runId)!,
      "mcp-route": mcpRunId === undefined ? metricByRun.get(local.meta.runId)! : metricByRun.get(mcpRunId)!,
      "fresh-client-resume": freshMetric!,
    };
    const dogfood = rdcBaseline(actual);
    return { ok: true, scenario: "full-alpha", projectId: project.projectId, steps, runs, inspection, comparison, dogfood, mcp: { presentation, presentationScope: "UTF-8 CallToolResult JSON; excludes JSON-RPC/transport framing; tokens are byte/4 proxies", protocol: "2026-07-28", listedTools, listPassed: toolResult, callPassed: toolResult, inspector: "pass" }, plugin, tunnel, cleanup: "completed" };
  } finally {
    await daemon?.stop();
    if (endpoint !== undefined) rmSync(endpoint, { force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

export const runFullAlpha = runFullAlphaScenario;
