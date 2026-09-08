import { createInterface } from 'node:readline';
import { ExecutionRuntime } from './runtime.ts';
import type { CommandSpec, RuntimeResult } from './types.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const tools = [
  { name: 'project.inspect', description: 'Inspect persisted runtime state and live Git state.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project.resume', description: 'Resume a project and return persisted tasks, decisions, events and artifacts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'shell.run', description: 'Run a bounded shell command inside the project root.', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' }, maxOutputBytes: { type: 'number' } } } },
  { name: 'process.start', description: 'Start a long-running shell process.', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' } } } },
  { name: 'process.wait', description: 'Wait for a started process and collect bounded output.', inputSchema: { type: 'object', required: ['processId'], properties: { processId: { type: 'string' } } } },
  { name: 'process.cancel', description: 'Cancel a started process.', inputSchema: { type: 'object', required: ['processId'], properties: { processId: { type: 'string' } } } },
  { name: 'file.read', description: 'Read a bounded project file; large files return an artifact reference.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, maxBytes: { type: 'number' } } } },
  { name: 'file.patch', description: 'Apply a unified diff to one project file and persist the patch artifact.', inputSchema: { type: 'object', required: ['patch'], properties: { patch: { type: 'string' } } } },
  { name: 'search', description: 'Search project text with rg when available and a bounded fallback otherwise.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, cwd: { type: 'string' }, maxMatches: { type: 'number' }, glob: { type: 'string' } } } },
  { name: 'verify', description: 'Run configured executable commands and record verification evidence.', inputSchema: { type: 'object', required: ['commands'], properties: { commands: { type: 'array' } } } },
];

export class McpRuntimeServer {
  private readonly runtime: ExecutionRuntime;

  constructor(runtime: ExecutionRuntime) {
    this.runtime = runtime;
  }

  async handle(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    if (request.id === undefined) return undefined;
    if (request.method === 'initialize') {
      return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ai-execution-runtime', version: '0.1.0' } } };
    }
    if (request.method === 'notifications/initialized') return undefined;
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id, result: { tools } };
    if (request.method === 'tools/call') {
      const name = String(request.params?.name ?? '');
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await this.call(name, args);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          ...(result.ok === false ? { isError: true } : {}),
        },
      };
    }
    return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method ?? ''}` } };
  }

  private async call(name: string, args: Record<string, unknown>): Promise<RuntimeResult<unknown>> {
    switch (name) {
      case 'project.inspect': return this.runtime.inspect();
      case 'project.resume': return this.runtime.resume();
      case 'shell.run': return this.runtime.shellRun(String(args.command ?? ''), { cwd: optionalString(args.cwd), timeoutMs: optionalNumber(args.timeoutMs), maxOutputBytes: optionalNumber(args.maxOutputBytes) });
      case 'process.start': return this.runtime.processStart(String(args.command ?? ''), { cwd: optionalString(args.cwd), timeoutMs: optionalNumber(args.timeoutMs) });
      case 'process.wait': return this.runtime.processWait(String(args.processId ?? ''));
      case 'process.cancel': return this.runtime.processCancel(String(args.processId ?? ''));
      case 'file.read': return this.runtime.fileRead(String(args.path ?? ''), optionalNumber(args.maxBytes));
      case 'file.patch': return this.runtime.filePatch(String(args.patch ?? ''));
      case 'search': return this.runtime.search(String(args.query ?? ''), { cwd: optionalString(args.cwd), maxMatches: optionalNumber(args.maxMatches), glob: optionalString(args.glob) });
      case 'verify': return this.runtime.verify((Array.isArray(args.commands) ? args.commands : []) as CommandSpec[]);
      default: return { ok: false, error: { code: 'NOT_FOUND', message: `Tool not found: ${name}`, retryable: false } };
    }
  }
}

const optionalString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const optionalNumber = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined;

const rootArgument = process.argv.indexOf('--root');
const rootPath = rootArgument >= 0 ? process.argv[rootArgument + 1] : process.cwd();
const runtime = new ExecutionRuntime({ rootPath: rootPath ?? process.cwd() });
const server = new McpRuntimeServer(runtime);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  void (async () => {
    try {
      const response = await server.handle(JSON.parse(line) as JsonRpcRequest);
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (cause) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: cause instanceof Error ? cause.message : String(cause) } })}\n`);
    }
  })();
});
input.on('close', () => runtime.close());
