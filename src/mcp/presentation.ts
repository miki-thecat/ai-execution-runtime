import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpPresentationMeasurements {
  readonly structuredBytes: number;
  readonly textBytes: number;
  readonly presentationBytes: number;
  readonly presentationTokenProxy: number;
}

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/** UTF-8 serialized tool result, excluding JSON-RPC/HTTP/stdio framing.
 * Text bytes count the unescaped text; presentation bytes include JSON escaping
 * and all content blocks. Byte / 4 is a proxy, never tokenizer usage.
 */
export function measureMcpPresentation(result: CallToolResult): McpPresentationMeasurements {
  const presentationBytes = bytes(JSON.stringify(result));
  return {
    structuredBytes: result.structuredContent === undefined ? 0 : bytes(JSON.stringify(result.structuredContent)),
    textBytes: result.content.reduce((total, block) => total + (block.type === "text" ? bytes(block.text) : 0), 0),
    presentationBytes,
    presentationTokenProxy: presentationBytes / 4,
  };
}
