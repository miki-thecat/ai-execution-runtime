import assert from "node:assert/strict";
import test from "node:test";
import { AERDaemon, createMcpFactory, createMcpHandler, registerMcpOperations, SqliteStateStore } from "../src/index.ts";

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
    assert.equal(daemon.state.listEvents({ type: "process.started" }).length, 0);
  } finally { state.close(); }
});
