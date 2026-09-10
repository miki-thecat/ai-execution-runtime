import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execPath, cwd } from "node:process";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runFullAlphaScenario } from "../../src/benchmark/index.ts";

test("Full Alpha walking skeleton and first RDC dogfood baseline pass", async () => {
  const report = await runFullAlphaScenario();
  assert.equal(report.ok, true);
  assert.equal(report.scenario, "full-alpha");

  const names = new Set(report.steps.map((entry) => entry.name));
  for (const required of [
    "project.init",
    "project.inspect",
    "project.resume",
    "direct command + bounded output/artifact",
    "file.read",
    "file.search",
    "guarded patch + ChangeSet",
    "verification",
    "github semantic snapshot",
    "github semantic wait",
    "optional Codex delegation",
    "run.inspect timeline",
    "run.compare hierarchy-aware metrics",
    "MCP Inspector list/call",
    "fresh-client resume",
  ]) assert.equal(names.has(required), true, `missing scenario step: ${required}`);
  assert.ok(report.inspection.timeline.length > 0);
  assert.equal(report.inspection.metrics.modelFacingOperations, 1);

  const metricFor = (operation: string) => {
    const step = report.steps.find((entry) => entry.operation === operation && entry.runId !== undefined);
    return step === undefined ? undefined : report.runs.find((metric) => metric.runId === step.runId);
  };
  const direct = metricFor("shell.run");
  assert.equal(direct?.modelFacingOperations, 1);
  assert.equal(direct?.internalCalls, 1, "process child evidence must not be double-counted");
  assert.ok((direct?.rawOutputBytes ?? 0) > (direct?.returnedOutputBytes ?? 0));

  const wait = metricFor("github.wait");
  assert.equal(wait?.pollCountModel, 0);
  assert.ok((wait?.pollCountInternal ?? 0) > 0);
  const delegation = metricFor("agent.run");
  assert.equal(delegation?.delegated.completed, 1);
  assert.deepEqual(delegation?.delegatedTokens, { input: 8, output: 4, cached: 2 });
  assert.deepEqual(delegation?.delegated.isolation[0], { userConfig: "ignored", execPolicy: "ignored" });

  assert.equal(report.mcp.protocol, "2026-07-28");
  assert.equal(report.mcp.listPassed, true);
  assert.equal(report.mcp.callPassed, true);
  assert.equal(report.plugin.status, "pass");
  assert.equal(report.plugin.deterministic, true);
  assert.equal(report.tunnel.status, "SKIPPED");
  assert.deepEqual(new Set(report.dogfood.map((entry) => entry.name)), new Set([
    "repo-inspection",
    "github-state",
    "long-wait",
    "small-patch-verify",
    "fresh-client-resume",
    "daemon-route",
    "mcp-route",
  ]));
});

test("official MCP stdio transport lists and calls a safe tool", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "aer-mcp-stdio-"));
  const transport = new StdioClientTransport({
    command: execPath,
    args: ["--experimental-strip-types", "src/cli/index.ts", "mcp"],
    cwd: cwd(),
    env: { AER_DATA_ROOT: runtimeRoot },
    stderr: "pipe",
  });
  const client = new Client({ name: "full-alpha-stdio-smoke", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "device.list"));
    const result = await client.callTool({ name: "device.list", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
