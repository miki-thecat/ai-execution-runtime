import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AERDaemon, type DaemonOperationResult } from "../server/index.ts";
import { createOperationMeta, createRuntimeError, runtimeSuccess } from "../core/index.ts";
import { createSemanticOperationEnvelope } from "../remote/index.ts";
import { ProjectRuntime } from "../project/index.ts";
import { TaskManager } from "../tasks/index.ts";
import { VerificationRunner } from "../verify/index.ts";
import { createFileOperations } from "../files/index.ts";
import { GitHubProvider, createGitHubOperations } from "../github/index.ts";
import { CodexAgentExecutor } from "../agents/index.ts";
import type { ExecutableCommand, ShellRunInput } from "../direct/index.ts";
import { sanitizeDurableText } from "../observability/redaction.ts";
import type { Operation } from "../operations/operation.ts";
import type { OperationContext } from "../core/context.ts";
import type { RuntimeBudgetOverrides } from "../policy/budgets.ts";
import { compareRuns, summarizeRun } from "../benchmark/compare.ts";

/** The modern protocol date supported by this surface. */
export const AER_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const AER_MCP_SERVER_NAME = "aer" as const;
export const AER_MCP_SERVER_VERSION = "0.1.0" as const;

export interface McpSurfaceOptions {
  /** Injecting a daemon is useful for embedding and keeps state AER-owned. */
  readonly daemon?: AERDaemon;
  readonly dataRoot?: string;
  /** Deterministic provider injection is used by the offline Full Alpha dogfood. */
  readonly github?: GitHubProvider;
  readonly agent?: CodexAgentExecutor;
}

export type McpServerFactory = () => McpServer;
export type McpRequestHandler = (request: Request) => Promise<Response>;

const budgetSchema = z.object({
  maxExecutionMs: z.number().int().positive().optional(),
  maxInputBytes: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  maxRawOutputBytes: z.number().int().positive().optional(),
  maxReturnedOutputBytes: z.number().int().positive().optional(),
  maxArtifactBytes: z.number().int().positive().optional(),
  maxFileReadBytes: z.number().int().positive().optional(),
  maxSearchResults: z.number().int().positive().optional(),
}).optional();

const projectArgs = {
  projectId: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  budgets: budgetSchema,
};

function bounded(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function safeError(error: unknown): { readonly code: string; readonly message: string; readonly effect: string; readonly retryable: boolean } {
  if (error !== null && typeof error === "object" && "code" in error && "message" in error) {
    const candidate = error as { code?: unknown; message?: unknown; effect?: unknown; retryable?: unknown };
    return {
      code: typeof candidate.code === "string" ? bounded(candidate.code, 120) : "MCP_REQUEST_FAILED",
      message: typeof candidate.message === "string" ? sanitizeDurableText(candidate.message, 2_000) : "MCP request failed",
      effect: candidate.effect === "unknown" || candidate.effect === "applied" ? candidate.effect : "none",
      retryable: candidate.retryable === true,
    };
  }
  return { code: "MCP_REQUEST_FAILED", message: "MCP request failed", effect: "none", retryable: false };
}

function structured(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function json(value: unknown): string {
  try { return JSON.stringify(value) ?? "null"; }
  catch { return JSON.stringify({ error: { code: "MCP_RESULT_NOT_SERIALIZABLE", message: "Result is not serializable" } }); }
}

function resultContent(result: DaemonOperationResult<unknown>): CallToolResult {
  if (result.ok) {
    const value = { data: result.data, meta: result.meta };
    return { content: [{ type: "text", text: json(value) }], structuredContent: value };
  }
  const error = safeError(result.error);
  const waiting = result.error.code === "EFFECT_APPROVAL_REQUIRED" || result.meta.policyDecision === "approval_required";
  const value = waiting
    ? { status: "waiting_approval", approvalRequired: true, error }
    : { status: result.meta.status, error };
  return {
    isError: !waiting,
    content: [{ type: "text", text: json(value) }],
    structuredContent: value,
  };
}

function projectIdFor(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function registerIfMissing(daemon: AERDaemon, operation: Operation<unknown, unknown>): void {
  if (!daemon.operations.has(operation.name)) daemon.register(operation);
}

function requireProject(daemon: AERDaemon, projectId: string): ReturnType<AERDaemon["projects"]["get"]> {
  return daemon.projects.get(projectId);
}

/** Register the compact adapter catalog once on an AER daemon. */
export function registerMcpOperations(daemon: AERDaemon, options: Pick<McpSurfaceOptions, "github" | "agent"> = {}): AERDaemon {
  daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online" });
  const projectRuntime = new ProjectRuntime({ state: daemon.state, tracer: daemon.tracer, artifacts: daemon.artifacts, direct: daemon.direct, registry: daemon.projects });
  const tasks = new TaskManager({ state: daemon.state, tracer: daemon.tracer });
  const verification = new VerificationRunner({ state: daemon.state, tracer: daemon.tracer, artifacts: daemon.artifacts, direct: daemon.direct, registry: daemon.projects });
  const github = options.github ?? new GitHubProvider({ direct: daemon.direct });
  const agent = options.agent ?? new CodexAgentExecutor({ state: daemon.state, tracer: daemon.tracer, artifacts: daemon.artifacts, registry: daemon.projects, tasks });

  registerIfMissing(daemon, {
    name: "project.inspect", effectClass: "read", executor: "runtime", provider: "aer",
    execute: (_input, context) => projectRuntime.inspect(context.projectId ?? "", context),
  });
  registerIfMissing(daemon, {
    name: "project.resume", effectClass: "read", executor: "runtime", provider: "aer",
    execute: (input, context) => projectRuntime.resume(context.projectId ?? "", context, input as { eventLimit?: number; itemLimit?: number }),
  });
  registerIfMissing(daemon, {
    name: "shell.run", effectClass: "destructive", executor: "direct", provider: "node:child_process",
    execute: (input: unknown, context: OperationContext) => {
      const project = requireProject(daemon, context.projectId ?? "");
      if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
      const value = input as ShellRunInput;
      return daemon.direct.runShell({ ...value, cwd: value.cwd ?? project.rootDir }, context, { instrument: false });
    },
  });
  registerIfMissing(daemon, {
    name: "process.run", effectClass: "destructive", executor: "direct", provider: "node:child_process",
    execute: (input: unknown, context: OperationContext) => {
      const project = requireProject(daemon, context.projectId ?? "");
      if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
      const value = input as ExecutableCommand;
      return daemon.direct.runExecutable({ ...value, cwd: value.cwd ?? project.rootDir }, context, { instrument: false });
    },
  });
  // File services are rooted per project. Register the compact adapters here
  // rather than exposing a second backend-shaped file API through MCP.
  for (const operation of [
    {
      name: "file.read", effectClass: "read" as const, executor: "direct", provider: "node:fs",
      execute: (input: unknown, context: OperationContext) => {
        const project = requireProject(daemon, context.projectId ?? "");
        if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
        return createFileOperations({ rootDir: project.rootDir, state: daemon.state, tracer: daemon.tracer, artifacts: daemon.artifacts }).read(input as import("../files/index.ts").FileReadInput, context, { instrument: false });
      },
    },
    {
      name: "file.search", effectClass: "read" as const, executor: "direct", provider: "node:fs/rg",
      execute: (input: unknown, context: OperationContext) => {
        const project = requireProject(daemon, context.projectId ?? "");
        if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
        return createFileOperations({ rootDir: project.rootDir, state: daemon.state, tracer: daemon.tracer, artifacts: daemon.artifacts }).search(input as import("../files/index.ts").FileSearchInput, context, { instrument: false });
      },
    },
    {
      name: "file.patch", effectClass: "workspace_write" as const, executor: "direct", provider: "node:fs",
      execute: (input: unknown, context: OperationContext) => {
        const project = requireProject(daemon, context.projectId ?? "");
        if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Project is not registered", retryable: false, effect: "none" });
        return createFileOperations({ rootDir: project.rootDir, state: daemon.state, tracer: daemon.tracer, artifacts: daemon.artifacts }).patch(input as import("../files/index.ts").FilePatchInput, context, { instrument: false });
      },
    },
  ] satisfies readonly Operation<unknown, unknown>[]) registerIfMissing(daemon, operation);
  registerIfMissing(daemon, {
    name: "verify.run", effectClass: "workspace_write", executor: "direct", provider: "node:child_process",
    execute: (input, context) => verification.run({ project: context.projectId ?? "", ...(input as { checkNames?: readonly string[] }) }, context),
  });
  registerIfMissing(daemon, {
    name: "artifact.read", effectClass: "read", executor: "runtime", provider: "aer",
    execute: (input, context) => {
      const value = input as { ref: import("../core/ids.ts").ArtifactRef; offset?: number; maxBytes?: number };
      const offset = value.offset ?? 0;
      const maxBytes = Math.min(value.maxBytes ?? 64 * 1024, context.budgets.maxReturnedOutputBytes, 64 * 1024);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw createRuntimeError({ code: "ARTIFACT_READ_INVALID", message: "Artifact offset and byte bound are invalid", retryable: false, effect: "none" });
      const metadata = daemon.artifacts.metadata(value.ref);
      if (metadata === undefined) throw createRuntimeError({ code: "ARTIFACT_NOT_FOUND", message: "Artifact metadata is not available", retryable: false, effect: "none" });
      const bytes = daemon.artifacts.read(value.ref, { offset, length: maxBytes });
      const nextOffset = offset + bytes.byteLength < metadata.size ? offset + bytes.byteLength : undefined;
      const content = new TextDecoder().decode(bytes);
      return runtimeSuccess({ ref: value.ref, offset, content, bytes: bytes.byteLength, totalBytes: metadata.size, ...(nextOffset === undefined ? {} : { nextOffset }), hasMore: nextOffset !== undefined }, createOperationMeta({ context, operation: "artifact.read", status: "completed", effectClass: "read", effectState: "none", metrics: { internalCalls: 1, rawOutputBytes: metadata.size, returnedOutputBytes: new TextEncoder().encode(content).byteLength }, summary: "Bounded artifact read" }));
    },
  });
  registerIfMissing(daemon, {
    name: "agent.run", effectClass: "workspace_write", executor: "agent", provider: "codex",
    execute: async (input, context) => {
      const value = input as { title?: string; prompt?: string; input?: string; goal?: string };
      const projectId = context.projectId;
      if (projectId === undefined) throw createRuntimeError({ code: "PROJECT_REQUIRED", message: "Agent work requires a canonical project target", retryable: false, effect: "none" });
      const task = tasks.create({ projectId, title: value.title ?? value.goal ?? "Delegated agent task", ...(value.goal === undefined ? {} : { goal: value.goal }), ...((value.prompt ?? value.input) === undefined ? {} : { description: value.prompt ?? value.input }) }, context);
      const run = await agent.run({ taskId: task.taskId, projectId, runId: task.runId, title: task.title, ...(value.goal === undefined ? {} : { goal: value.goal }), ...(value.prompt === undefined ? {} : { prompt: value.prompt }), ...(value.input === undefined ? {} : { input: value.input }) }, context);
      return runtimeSuccess(run, createOperationMeta({ context, operation: "agent.run", status: run.status === "unknown" ? "unknown" : run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed", effectClass: "workspace_write", effectState: run.effectState, metrics: { durationMs: run.metrics.durationMs, internalCalls: run.metrics.commandCount + run.metrics.toolCallCount, retries: run.metrics.retries, inputBytes: run.metrics.inputBytes, rawOutputBytes: run.metrics.rawOutputBytes, returnedOutputBytes: run.metrics.returnedOutputBytes, artifactBytes: run.metrics.artifactBytes, ...(run.metrics.usage?.inputTokens === undefined ? {} : { tokenInput: run.metrics.usage.inputTokens }), ...(run.metrics.usage?.outputTokens === undefined ? {} : { tokenOutput: run.metrics.usage.outputTokens }), ...(run.metrics.usage?.cachedInputTokens === undefined ? {} : { tokenCached: run.metrics.usage.cachedInputTokens }) }, artifactRefs: run.artifactRefs, summary: bounded(run.summary), executor: "agent", provider: "codex" }));
    },
  });
  for (const operation of createGitHubOperations(github)) registerIfMissing(daemon, operation);
  registerIfMissing(daemon, {
    name: "device.list", effectClass: "read", executor: "runtime", provider: "aer",
    execute: (_input, context) => runtimeSuccess(daemon.listDevices(), createOperationMeta({ context, operation: "device.list", status: "completed", effectClass: "read", effectState: "none", summary: "Devices listed" })),
  });
  registerIfMissing(daemon, {
    name: "run.inspect", effectClass: "read", executor: "runtime", provider: "aer",
    execute: (input, context) => {
      const runId = (input as { runId: string }).runId;
      const run = daemon.state.getRun(runId as never);
      const events = daemon.state.listEvents({ runId: runId as never, limit: 20, order: "asc" });
      const metrics = summarizeRun(runId, daemon.state.listEvents({ runId: runId as never, limit: 1_000, order: "asc" }), daemon.state);
      const timeline = events.map((event) => ({
        eventId: event.eventId,
        timestamp: event.timestamp,
        type: event.type,
        ...(event.operation === undefined ? {} : { operation: event.operation }),
        ...(event.status === undefined ? {} : { status: event.status }),
        spanId: event.spanId,
        ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
        durationMs: event.durationMs,
        internalCalls: event.internalCalls,
        pollCountInternal: event.pollCountInternal,
        pollCountModel: event.pollCountModel,
        rawOutputBytes: event.rawOutputBytes,
        returnedOutputBytes: event.returnedOutputBytes,
        filesChanged: event.filesChanged,
        ...(event.effectState === undefined ? {} : { effectState: event.effectState }),
        artifactRefs: event.artifactRefs,
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      }));
      const compact = { run, events: timeline, timeline, metrics };
      return runtimeSuccess(compact, createOperationMeta({ context, operation: "run.inspect", status: "completed", effectClass: "read", effectState: "none", metrics: { internalCalls: 1, rawOutputBytes: JSON.stringify(events).length, returnedOutputBytes: JSON.stringify(compact).length }, summary: "Run inspected" }));
    },
  });
  registerIfMissing(daemon, {
    name: "run.compare", effectClass: "read", executor: "runtime", provider: "aer",
    execute: (input, context) => {
      const value = input as { runIds?: readonly string[]; a?: string; b?: string };
      const runIds = value.runIds ?? [value.a, value.b].filter((id): id is string => typeof id === "string" && id.trim() !== "");
      if (runIds.length === 0 || runIds.length > 20) throw createRuntimeError({ code: "RUN_COMPARE_INPUT_INVALID", message: "run.compare requires between one and twenty run IDs", retryable: false, effect: "none" });
      const comparison = compareRuns(runIds, daemon.state);
      return runtimeSuccess(comparison, createOperationMeta({ context, operation: "run.compare", status: "completed", effectClass: "read", effectState: "none", metrics: { internalCalls: 1, returnedOutputBytes: JSON.stringify(comparison).length }, summary: "Runs compared" }));
    },
  });
  return daemon;
}

function inputWithoutTarget(input: Record<string, unknown>): { readonly projectId?: string; readonly budgets?: RuntimeBudgetOverrides; readonly input: Record<string, unknown> } {
  const { projectId, project, budgets, ...rest } = input;
  const selected = projectId ?? project;
  const selectedProject = selected === undefined ? undefined : projectIdFor(selected as string);
  return { ...(selectedProject === undefined ? {} : { projectId: selectedProject }), ...(budgets === undefined ? {} : { budgets: budgets as RuntimeBudgetOverrides }), input: rest };
}

async function call(daemon: AERDaemon, operation: string, input: Record<string, unknown>): Promise<DaemonOperationResult<unknown>> {
  const target = inputWithoutTarget(input);
  const onlyProject = daemon.projects.list();
  const selectedProject = target.projectId ?? (onlyProject.length === 1 ? onlyProject[0]?.projectId : undefined);
  return daemon.execute(createSemanticOperationEnvelope({ operation, input: target.input, ...(selectedProject === undefined ? {} : { projectId: selectedProject as never }), ...(target.budgets === undefined ? {} : { budgets: target.budgets }), actor: "model" }));
}

/** Build a fresh SDK McpServer. The daemon and its state remain shared/authoritative. */
export function createMcpServer(options: McpSurfaceOptions = {}): McpServer {
  const daemon = registerMcpOperations(options.daemon ?? new AERDaemon(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }), options);
  const server = new McpServer({ name: AER_MCP_SERVER_NAME, version: AER_MCP_SERVER_VERSION }, { instructions: "AER owns project, task, effect, budget, and run state. Client effect assertions are ignored." });

  server.registerTool("project.inspect", { description: "Inspect the registered project and bounded local Git state.", inputSchema: projectArgs }, async (input) => resultContent(await call(daemon, "project.inspect", input as Record<string, unknown>)));
  server.registerTool("project.resume", { description: "Resume bounded project context from AER durable state.", inputSchema: { ...projectArgs, eventLimit: z.number().int().positive().max(100).optional(), itemLimit: z.number().int().positive().max(100).optional() } }, async (input) => resultContent(await call(daemon, "project.resume", input as Record<string, unknown>)));
  server.registerTool("file.read", { description: "Read a bounded file inside the registered project root.", inputSchema: { ...projectArgs, path: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(), maxBytes: z.number().int().positive().max(65536).optional() } }, async (input) => resultContent(await call(daemon, "file.read", input as Record<string, unknown>)));
  server.registerTool("file.search", { description: "Search bounded project files and return compact matches.", inputSchema: { ...projectArgs, query: z.string().min(1), path: z.string().optional(), regex: z.boolean().optional(), maxResults: z.number().int().positive().max(100).optional(), maxBytes: z.number().int().positive().max(65536).optional() } }, async (input) => resultContent(await call(daemon, "file.search", input as Record<string, unknown>)));
  server.registerTool("file.patch", { description: "Apply a guarded file replacement and record a ChangeSet.", inputSchema: { ...projectArgs, path: z.string().min(1), expectedHash: z.string().nullable().optional(), content: z.string().optional(), patch: z.string().optional() } }, async (input) => resultContent(await call(daemon, "file.patch", input as Record<string, unknown>)));
  server.registerTool("shell.run", { description: "Run a bounded shell command under AER policy.", inputSchema: { ...projectArgs, command: z.string().min(1).max(32768), timeoutMs: z.number().int().positive().max(600000).optional(), maxOutputBytes: z.number().int().positive().max(65536).optional() } }, async (input) => resultContent(await call(daemon, "shell.run", input as Record<string, unknown>)));
  server.registerTool("verify.run", { description: "Run the registered project verification plan.", inputSchema: { ...projectArgs, checkNames: z.array(z.string().min(1)).max(100).optional() } }, async (input) => resultContent(await call(daemon, "verify.run", input as Record<string, unknown>)));
  server.registerTool("github.snapshot", { description: "Return a bounded semantic GitHub snapshot.", inputSchema: { ...projectArgs, cwd: z.string().optional(), issueNumber: z.number().int().positive().optional(), issueNumbers: z.array(z.number().int().positive()).max(100).optional(), includeWork: z.boolean().optional() } }, async (input) => resultContent(await call(daemon, "github.snapshot", input as Record<string, unknown>)));
  server.registerTool("github.wait", { description: "Wait inside AER for GitHub checks to settle.", inputSchema: { ...projectArgs, cwd: z.string().optional(), pullRequest: z.union([z.number().int().positive(), z.string().min(1)]), condition: z.enum(["checks_terminal", "checks_passed"]).optional(), intervalMs: z.number().int().positive().max(30000).optional(), timeoutMs: z.number().int().positive().max(600000).optional(), maxPolls: z.number().int().positive().max(1000).optional() } }, async (input) => resultContent(await call(daemon, "github.wait", input as Record<string, unknown>)));
  server.registerTool("agent.run", { description: "Delegate one bounded task to Codex through AER.", inputSchema: { ...projectArgs, title: z.string().min(1).max(500).optional(), goal: z.string().max(2000).optional(), prompt: z.string().max(32768).optional(), input: z.string().max(32768).optional() } }, async (input) => resultContent(await call(daemon, "agent.run", input as Record<string, unknown>)));
  server.registerTool("device.list", { description: "List AER-known device presence and capabilities.", inputSchema: { budgets: budgetSchema } }, async (input) => resultContent(await call(daemon, "device.list", input as Record<string, unknown>)));
  server.registerTool("run.inspect", { description: "Inspect bounded durable state for one AER run.", inputSchema: { runId: z.string().min(1), budgets: budgetSchema } }, async (input) => resultContent(await call(daemon, "run.inspect", input as Record<string, unknown>)));
  server.registerTool("run.compare", { description: "Compare hierarchy-aware metrics for AER runs.", inputSchema: { runIds: z.array(z.string().min(1)).min(1).max(20), budgets: budgetSchema } }, async (input) => resultContent(await call(daemon, "run.compare", input as Record<string, unknown>)));
  server.registerTool("artifact.read", { description: "Read a bounded local evidence artifact.", inputSchema: { ref: z.string().min(1), offset: z.number().int().nonnegative().optional(), maxBytes: z.number().int().nonnegative().max(65536).optional(), budgets: budgetSchema } }, async (input) => resultContent(await call(daemon, "artifact.read", input as Record<string, unknown>)));
  return server;
}

export function createMcpFactory(options: McpSurfaceOptions = {}): McpServerFactory {
  const daemon = registerMcpOperations(options.daemon ?? new AERDaemon(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }), options);
  return () => createMcpServer({ daemon });
}

/** Official SDK Streamable HTTP adapter; every request gets a new server and transport. */
export function createMcpHandler(factory: McpServerFactory = createMcpFactory()): McpRequestHandler {
  return async (request) => {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "MCP request failed" }, id: null }), { status: 500, headers: { "content-type": "application/json" } });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

/** Official SDK stdio serving entry. Stdio is the default safe local path. */
export async function serveStdio(factory: McpServerFactory = createMcpFactory(), transport?: StdioServerTransport): Promise<void> {
  const server = factory();
  const stdio = transport ?? new StdioServerTransport();
  await server.connect(stdio);
}

export const createAERMcpServer = createMcpServer;
export const createAERMcpFactory = createMcpFactory;
export const createMcpHttpHandler = createMcpHandler;
