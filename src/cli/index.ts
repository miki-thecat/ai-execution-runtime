#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { argv, cwd as processCwd, env, exit, stdout, versions } from "node:process";
import { AERDaemon, DEFAULT_AER_DATA_ROOT, DEFAULT_AER_RUNTIME_DIRECTORY, DEFAULT_AER_SOCKET_NAME, type DaemonOperationResult } from "../server/index.ts";
import { createMcpFactory, createMcpHandler, registerMcpOperations } from "../mcp/index.ts";
import { probeLocalEndpoint } from "../remote/index.ts";
import { createSemanticOperationEnvelope } from "../remote/index.ts";
import type { RuntimeBudgetOverrides } from "../policy/budgets.ts";
import { sanitizeDurableText } from "../observability/redaction.ts";
import { compareRuns } from "../benchmark/compare.ts";

export interface CliOptions {
  readonly dataRoot?: string;
  readonly cwd?: string;
  readonly output?: (line: string) => void;
  readonly errorOutput?: (line: string) => void;
}

export interface CliEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly effect?: string; readonly retryable?: boolean };
}

const MAX_ERROR_TEXT = 2_000;

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, MAX_ERROR_TEXT) : fallback;
}

function safeError(error: unknown): NonNullable<CliEnvelope["error"]> {
  if (error !== null && typeof error === "object" && "code" in error && "message" in error) {
    const value = error as { code?: unknown; message?: unknown; effect?: unknown; retryable?: unknown };
    return {
      code: safeText(value.code, "CLI_REQUEST_FAILED"),
      message: typeof value.message === "string" ? sanitizeDurableText(value.message, MAX_ERROR_TEXT) : "CLI request failed",
      ...(value.effect === "unknown" || value.effect === "applied" || value.effect === "none" ? { effect: value.effect } : {}),
      ...(value.retryable === true ? { retryable: true } : {}),
    };
  }
  return { code: "CLI_REQUEST_FAILED", message: "CLI request failed" };
}

function stableValue(value: unknown, seen = new Set<unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => stableValue(item, seen))
    : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableValue(child, seen)]));
  seen.delete(value);
  return result;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? "null";
}

function commandAvailable(command: string): { readonly available: boolean; readonly version?: string; readonly error?: string } {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000 });
  if (result.status !== 0 || result.error !== undefined) return { available: false, ...(result.error === undefined ? {} : { error: "not found" }) };
  const version = `${result.stdout ?? ""}`.trim().split("\n")[0];
  return { available: true, ...(version === undefined || version === "" ? {} : { version: version.slice(0, 200) }) };
}

export interface DoctorReport {
  readonly node: { readonly available: true; readonly version: string };
  readonly git: ReturnType<typeof commandAvailable>;
  readonly gh: ReturnType<typeof commandAvailable>;
  readonly codex: ReturnType<typeof commandAvailable>;
  readonly sqlite: { readonly available: boolean; readonly version?: string };
  readonly sandbox: { readonly available: boolean; readonly providers: Readonly<Record<string, boolean>> };
  readonly daemon: { readonly status: "online" | "offline" | "unknown"; readonly endpoint: string };
  readonly tunnelClient: ReturnType<typeof commandAvailable>;
  readonly tunnel: { readonly client: "available" | "unavailable"; readonly entitlement: "unverified" };
}

export async function doctor(dataRoot = DEFAULT_AER_DATA_ROOT): Promise<DoctorReport> {
  const endpoint = join(resolve(dataRoot), DEFAULT_AER_RUNTIME_DIRECTORY, DEFAULT_AER_SOCKET_NAME);
  let daemon: DoctorReport["daemon"];
  try {
    const state = await probeLocalEndpoint(endpoint, 250);
    daemon = { status: state === "live" ? "online" : state === "stale" ? "offline" : "unknown", endpoint };
  } catch { daemon = { status: "unknown", endpoint }; }
  const docker = commandAvailable("docker").available;
  const sbx = commandAvailable("sbx").available;
  const nodeVersion = versions.node;
  return {
    node: { available: true, version: nodeVersion },
    git: commandAvailable("git"),
    gh: commandAvailable("gh"),
    codex: commandAvailable("codex"),
    sqlite: { available: true, version: nodeVersion },
    sandbox: { available: docker || sbx, providers: { docker, sbx } },
    daemon,
    tunnelClient: commandAvailable("tunnel-client"),
    tunnel: { client: commandAvailable("tunnel-client").available ? "available" : "unavailable", entitlement: "unverified" },
  };
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function makeDaemon(dataRoot: string): AERDaemon {
  const daemon = registerMcpOperations(new AERDaemon({ dataRoot }));
  daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online" });
  return daemon;
}

function finishDaemon(daemon: AERDaemon): void {
  if (!daemon.isRunning) daemon.state.close();
}

function projectFor(daemon: AERDaemon, root: string, create = false): string {
  const existing = daemon.projects.get(root);
  if (existing !== undefined) return existing.projectId;
  if (!create) throw Object.assign(new Error("Project is not registered; run aer init first"), { code: "PROJECT_NOT_FOUND" });
  return daemon.registerProject({ rootDir: root, writeConfig: false }).projectId;
}

async function execute(daemon: AERDaemon, operation: string, input: unknown, projectId?: string, budgets?: RuntimeBudgetOverrides): Promise<DaemonOperationResult<unknown>> {
  return daemon.execute(createSemanticOperationEnvelope({ operation, input, ...(projectId === undefined ? {} : { projectId: projectId as never }), ...(budgets === undefined ? {} : { budgets }), actor: "model" }));
}

function presented(result: DaemonOperationResult<unknown>): unknown {
  return result.ok ? { data: result.data, meta: result.meta } : { error: safeError(result.error), meta: result.meta };
}

export async function runCli(arguments_: readonly string[] = argv.slice(2), options: CliOptions = {}): Promise<CliEnvelope> {
  const rawArgs = [...arguments_];
  const dataRootFlag = rawArgs.indexOf("--data-root");
  const cwdFlag = rawArgs.indexOf("--cwd");
  const selectedDataRoot = dataRootFlag >= 0 ? rawArgs[dataRootFlag + 1] : undefined;
  const selectedCwd = cwdFlag >= 0 ? rawArgs[cwdFlag + 1] : undefined;
  const args = rawArgs.filter((_value, index) => !((dataRootFlag >= 0 && (index === dataRootFlag || index === dataRootFlag + 1)) || (cwdFlag >= 0 && (index === cwdFlag || index === cwdFlag + 1))));
  const command = args[0] ?? "help";
  const dataRoot = resolve(options.dataRoot ?? selectedDataRoot ?? env.AER_DATA_ROOT ?? DEFAULT_AER_DATA_ROOT);
  const cwd = resolve(options.cwd ?? selectedCwd ?? processCwd());
  try {
    if (command === "doctor") return { ok: true, command, data: await doctor(dataRoot) };
    if (command === "help" || command === "--help" || command === "-h") return { ok: true, command: "help", data: { commands: ["doctor", "init", "inspect", "resume", "run", "verify", "github snapshot", "github wait", "agent codex", "runs list", "runs show", "runs compare", "device list", "mcp", "daemon"] } };
    if (command === "init") {
      const root = resolve(args[1] ?? cwd);
      const daemon = makeDaemon(dataRoot);
      try { return { ok: true, command, data: daemon.registerProject({ rootDir: root }) }; }
      finally { finishDaemon(daemon); }
    }
    if (command === "daemon") {
      const daemon = makeDaemon(dataRoot);
      await daemon.start();
      return { ok: true, command, data: { status: "online", endpoint: daemon.endpoint, deviceId: daemon.deviceId } };
    }
    if (command === "mcp") {
      const http = args.includes("--http");
      const daemon = makeDaemon(dataRoot);
      if (!http) {
        await (await import("../mcp/index.ts")).serveStdio(createMcpFactory({ daemon }));
        // The stdio transport owns the process after connect. Keeping this
        // promise pending keeps the daemon state alive and prevents the CLI
        // JSON envelope from being written onto the MCP stdout stream.
        return await new Promise<CliEnvelope>(() => undefined);
      }
      const port = parseNumber(args[args.indexOf("--port") + 1]) ?? 8787;
      const listener = await serveMcpHttp({ daemon, port });
      return { ok: true, command, data: { transport: "streamable-http", host: "127.0.0.1", port: listener.addressPort } };
    }
    const daemon = makeDaemon(dataRoot);
    try {
      if (command === "inspect" || command === "resume" || command === "verify") {
        const projectId = projectFor(daemon, cwd);
        const operation = command === "inspect" ? "project.inspect" : command === "resume" ? "project.resume" : "verify.run";
        const input = command === "resume" ? { eventLimit: parseNumber(args[1]) ?? 50, itemLimit: 50 } : command === "verify" ? {} : {};
        const result = await execute(daemon, operation, input, projectId);
        return result.ok ? { ok: true, command, data: presented(result) } : { ok: false, command, error: safeError(result.error), data: presented(result) };
      }
      if (command === "run") {
        const projectId = projectFor(daemon, cwd);
        const shell = args.slice(1).filter((arg) => arg !== "--json").join(" ");
        if (shell.trim() === "") throw Object.assign(new Error("A command is required"), { code: "CLI_COMMAND_REQUIRED" });
        const result = await execute(daemon, "shell.run", { command: shell }, projectId);
        return result.ok ? { ok: true, command, data: presented(result) } : { ok: false, command, error: safeError(result.error), data: presented(result) };
      }
      if (command === "process") {
        const subcommand = args[1] ?? "start";
        if (subcommand === "start" || subcommand === "run") {
          const projectId = projectFor(daemon, cwd);
          const executable = args[2];
          if (executable === undefined || executable.trim() === "") throw Object.assign(new Error("An executable is required"), { code: "CLI_EXECUTABLE_REQUIRED" });
          const result = await execute(daemon, "process.run", { executable, args: args.slice(3) }, projectId);
          return result.ok ? { ok: true, command: `process ${subcommand}`, data: presented(result) } : { ok: false, command: `process ${subcommand}`, error: safeError(result.error), data: presented(result) };
        }
        if (subcommand === "wait" || subcommand === "cancel") {
          const processId = args[2];
          if (processId === undefined) throw Object.assign(new Error("A process ID is required"), { code: "CLI_PROCESS_ID_REQUIRED" });
          return { ok: true, command: `process ${subcommand}`, data: daemon.state.getEntity("processes", processId) ?? { processId, status: "unknown" } };
        }
      }
      if (command === "github") {
        const subcommand = args[1] ?? "snapshot";
        const operation = subcommand === "wait" ? "github.wait" : "github.snapshot";
        const projectId = projectFor(daemon, cwd);
        const input = subcommand === "wait" ? { cwd, pullRequest: parseNumber(args[2]) ?? args[2], condition: "checks_terminal" } : { cwd, includeWork: args.includes("--work"), ...(parseNumber(args[2]) === undefined ? {} : { issueNumber: parseNumber(args[2]) }) };
        const result = await execute(daemon, operation, input, projectId);
        return result.ok ? { ok: true, command: `github ${subcommand}`, data: presented(result) } : { ok: false, command: `github ${subcommand}`, error: safeError(result.error), data: presented(result) };
      }
      if (command === "agent" && args[1] === "codex") {
        const projectId = projectFor(daemon, cwd);
        const result = await execute(daemon, "agent.run", { title: args.slice(2).join(" ") || "Delegated Codex task", prompt: args.slice(2).join(" ") }, projectId);
        return result.ok ? { ok: true, command: "agent codex", data: presented(result) } : { ok: false, command: "agent codex", error: safeError(result.error), data: presented(result) };
      }
      if (command === "device" && args[1] === "list") {
        const result = await execute(daemon, "device.list", {});
        return result.ok ? { ok: true, command: "device list", data: presented(result) } : { ok: false, command: "device list", error: safeError(result.error), data: presented(result) };
      }
      if (command === "runs") {
        const subcommand = args[1] ?? "list";
        if (subcommand === "list") return { ok: true, command: "runs list", data: daemon.state.listEntities("runs", { limit: 100 }) };
        if (subcommand === "show" || subcommand === "compare") {
          const ids = args.slice(2).filter((value) => value !== "--json");
          if (subcommand === "compare") {
            if (ids.length === 0) throw Object.assign(new Error("At least one run ID is required"), { code: "CLI_RUN_ID_REQUIRED" });
            return { ok: true, command: "runs compare", data: compareRuns(ids, daemon.state) };
          }
          const data = ids.map((id) => daemon.state.getRun(id as never) ?? { runId: id, status: "unknown" });
          return { ok: true, command: "runs show", data: data[0] };
        }
      }
      throw Object.assign(new Error("Unknown command"), { code: "CLI_COMMAND_UNKNOWN" });
    } finally { finishDaemon(daemon); }
  } catch (error) {
    return { ok: false, command, error: safeError(error) };
  }
}

export interface McpHttpListener {
  readonly addressPort: number;
  readonly close: () => Promise<void>;
}

async function requestBody(request: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; if (new TextEncoder().encode(body).byteLength > limit) reject(new Error("request too large")); });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

async function writeWebResponse(response: Response, output: ServerResponse): Promise<void> {
  output.statusCode = response.status;
  response.headers.forEach((value, key) => output.setHeader(key, value));
  output.end(await response.text());
}

export async function serveMcpHttp(options: { readonly daemon?: AERDaemon; readonly dataRoot?: string; readonly port?: number } = {}): Promise<McpHttpListener> {
  const daemon = options.daemon ?? makeDaemon(options.dataRoot ?? DEFAULT_AER_DATA_ROOT);
  const handler = createMcpHandler(createMcpFactory({ daemon }));
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
      const body = await requestBody(request);
      const webRequest = new Request(`http://127.0.0.1${request.url ?? "/mcp"}`, { method: "POST", headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")), body });
      await writeWebResponse(await handler(webRequest), response);
    } catch { response.statusCode = 400; response.end(JSON.stringify({ error: { code: "MCP_HTTP_REQUEST_INVALID", message: "MCP HTTP request is invalid" } })); }
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(options.port ?? 8787, "127.0.0.1", () => resolveListen()); });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 8787;
  return { addressPort: port, close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error))) };
}

export async function main(arguments_: readonly string[] = argv.slice(2)): Promise<void> {
  const result = await runCli(arguments_);
  stdout.write(`${stableJson(result)}\n`);
  if (!result.ok) exit(1);
}

if (argv[1] !== undefined && resolve(argv[1]) === resolve(fileURLToPath(import.meta.url))) void main();
