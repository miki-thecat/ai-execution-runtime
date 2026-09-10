import { measureMcpPresentation } from "../src/mcp/presentation.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { AERDaemon, createMcpFactory, createMcpHandler, registerMcpOperations, SqliteStateStore } from "../src/index.ts";
import { runCli } from "../src/cli/index.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function mcpCall(handler: (request: Request) => Promise<Response>, id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await handler(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }));
  assert.equal(response.status, 200);
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

test("modern stateless MCP calls shared AER state without discover", async () => {
  const state = new SqliteStateStore(":memory:");
  const daemon = registerMcpOperations(new AERDaemon({ state, dataRoot: process.cwd() }));
  const project = daemon.registerProject({ rootDir: process.cwd(), writeConfig: false });
  let factories = 0;
  const handler = createMcpHandler(() => { factories += 1; return createMcpFactory({ daemon })(); });
  try {
    const initialized = await mcpCall(handler, 1, "initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(typeof initialized.result, "object");
    const called = await mcpCall(handler, 2, "tools/call", { name: "project.inspect", arguments: { projectId: project.projectId } });
    const result = called.result as { structuredContent?: { data?: { projectId?: string } }; isError?: boolean };
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.data?.projectId, project.projectId);
    const presentation = measureMcpPresentation(called.result as never);
    const content = (called.result as { content: { text: string }[] }).content;
    const summary = JSON.parse(content[0]!.text);
    assert.equal(summary.operation, "project.inspect");
    assert.equal(summary.data, undefined);
    assert.ok(presentation.textBytes < 2500);
    assert.ok(presentation.textBytes < presentation.structuredBytes);
    const events = state.listEvents({ type: "mcp.presented" });
    assert.equal(events.length, 1);
    for (const [key, value] of Object.entries(presentation)) assert.equal(events[0]?.metadata?.[key === "presentationTokenProxy" ? "presentationByteQuarterProxy" : key], value);
    assert.equal(events[0]?.returnedOutputBytes, 0);
    assert.equal(factories, 2);
  } finally { state.close(); }
});

test("MCP schema and AER effect authority fail closed", async () => {
  const state = new SqliteStateStore(":memory:");
  const daemon = registerMcpOperations(new AERDaemon({ state, dataRoot: process.cwd() }));
  const project = daemon.registerProject({ rootDir: process.cwd(), writeConfig: false });
  const handler = createMcpHandler(createMcpFactory({ daemon }));
  try {
    const invalid = await mcpCall(handler, 3, "tools/call", { name: "file.read", arguments: { projectId: project.projectId, path: "" } });
    assert.equal((invalid.result as { isError?: boolean }).isError, true);
    const approval = await mcpCall(handler, 4, "tools/call", { name: "shell.run", arguments: { projectId: project.projectId, command: "touch should-not-run", effectClass: "read", budgets: { maxExecutionMs: 999999999 } } });
    const structured = (approval.result as { structuredContent?: { status?: string; error?: { code?: string } }; isError?: boolean }).structuredContent;
    assert.equal(structured?.status, "waiting_approval");
    assert.equal(structured?.error?.code, "EFFECT_APPROVAL_REQUIRED");
    assert.notEqual((approval.result as { isError?: boolean }).isError, true);
    const approvalResult = approval.result as { content: { text: string }[] };
    assert.deepEqual(JSON.parse(approvalResult.content[0]!.text), structured);
    const failed = await mcpCall(handler, 5, "tools/call", { name: "file.read", arguments: { projectId: project.projectId, path: "../outside" } });
    const failure = failed.result as { isError: boolean; content: { text: string }[]; structuredContent: { error: { code: string; retryable: boolean; effect: string } } };
    assert.equal(failure.isError, true);
    assert.equal(typeof failure.structuredContent.error.code, "string");
    assert.equal(typeof failure.structuredContent.error.retryable, "boolean");
    assert.deepEqual(JSON.parse(failure.content[0]!.text), failure.structuredContent);
    assert.equal(daemon.state.listEvents({ type: "process.started" }).length, 0);
  } finally { state.close(); }
});


test("CLI init resolves relative project paths against --cwd/options cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "aer-cli-cwd-"));
  const project = join(root, "project");
  const dataRoot = join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(project));
  try {
    const initialized = await runCli(["init", "."], { cwd: project, dataRoot });
    assert.equal(initialized.ok, true);
    const data = initialized.data as { root?: string; rootDir?: string };
    assert.equal(data.root, project);
    assert.equal(data.rootDir, project);
    const inspected = await runCli(["inspect"], { cwd: project, dataRoot });
    assert.equal(inspected.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI init updates an existing verification plan, which requires explicit trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "aer-cli-verify-"));
  const project = join(root, "project");
  const dataRoot = join(root, "state");
  await mkdir(project);
  try {
    const initialized = await runCli(["init", "."], { cwd: project, dataRoot });
    assert.equal(initialized.ok, true);
    const planned = await runCli(["init", ".", "--verify", "node -e \"process.stdout.write('changed')\""], { cwd: project, dataRoot });
    assert.equal(planned.ok, true);
    const rejected = await runCli(["verify"], { cwd: project, dataRoot });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "TRUSTED_VERIFICATION_PLAN_MISSING");
    const trusted = await runCli(["verify", "trust"], { cwd: project, dataRoot });
    assert.equal(trusted.ok, true);
    const rerun = await runCli(["verify"], { cwd: project, dataRoot });
    assert.equal(rerun.ok, true);
    assert.equal((rerun.data as { data?: { checks?: unknown[] } }).data?.checks?.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI init trusts a fresh verification plan with multiple checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "aer-cli-fresh-verify-"));
  const project = join(root, "project");
  const dataRoot = join(root, "state");
  await mkdir(project);
  try {
    const initialized = await runCli([
      "init",
      ".",
      "--verify",
      "node -e \"process.stdout.write('first')\"",
      "--verify",
      "node -e \"process.stdout.write('second')\"",
    ], { cwd: project, dataRoot });
    assert.equal(initialized.ok, true);
    assert.equal((initialized.data as { boundary?: { verificationPlan?: { status?: string } } }).boundary?.verificationPlan?.status, "trusted");

    const verified = await runCli(["verify"], { cwd: project, dataRoot });
    assert.equal(verified.ok, true);
    assert.equal((verified.data as { data?: { checks?: unknown[] } }).data?.checks?.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("local CLI approval is explicit, one-shot, audited, and runs in the canonical project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "aer-cli-approval-"));
  const project = join(root, "project");
  const dataRoot = join(root, "state");
  await mkdir(project);
  try {
    const initialized = await runCli(["init", "."], { cwd: project, dataRoot });
    assert.equal(initialized.ok, true);

    const blocked = await runCli(["run", "pwd"], { cwd: project, dataRoot });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "EFFECT_APPROVAL_REQUIRED");

    const approved = await runCli(["run", "--approve", "pwd"], { cwd: project, dataRoot });
    assert.equal(approved.ok, true);
    const approvedData = approved.data as { data?: { stdout?: string }; meta?: { effectClass?: string; policyDecision?: string } };
    assert.equal(approvedData.data?.stdout?.trim(), project);
    assert.equal(approvedData.meta?.effectClass, "destructive");
    assert.equal(approvedData.meta?.policyDecision, "allow");

    const state = new SqliteStateStore(join(dataRoot, "aer.db"));
    try {
      const decisions = state.listEntities("decisions", { projectId: (initialized.data as { projectId: string }).projectId });
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.status, "consumed");
      assert.equal(decisions[0]?.data?.source, "local-cli");
      assert.equal(decisions[0]?.data?.oneShot, true);
      assert.equal(decisions[0]?.data?.operation, "shell.run");
      assert.equal(typeof decisions[0]?.data?.argumentsDigest, "string");
      assert.equal(JSON.stringify(decisions[0]?.data).includes("pwd"), false);
      assert.equal(state.listEvents({ type: "approval.requested" }).length, 1);
      assert.equal(state.listEvents({ type: "approval.resolved" }).length, 1);
      assert.equal(state.listEvents({ type: "process.started" }).length, 1);
    } finally { state.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
