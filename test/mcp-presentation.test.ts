import assert from "node:assert/strict";
import test from "node:test";
import { measureMcpPresentation } from "../src/mcp/presentation.ts";

test("presentation measures UTF-8, JSON escaping, and byte/4 proxy separately", () => {
  const result = { content: [{ type: "text" as const, text: '日本語\n"' }], structuredContent: { data: "é" } };
  const measured = measureMcpPresentation(result);
  assert.equal(measured.textBytes, 11);
  assert.equal(measured.structuredBytes, Buffer.byteLength(JSON.stringify(result.structuredContent)));
  assert.equal(measured.presentationBytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(measured.presentationTokenProxy, measured.presentationBytes / 4);
  assert.equal(measureMcpPresentation({ content: [] }).structuredBytes, 0);
});
