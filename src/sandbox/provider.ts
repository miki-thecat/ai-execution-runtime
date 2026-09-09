import { spawnSync } from "node:child_process";
import { isDeadlineExceeded, type OperationContext } from "../core/context.ts";
import { createRuntimeError, policyDecisionEvidence, type EffectClass } from "../core/index.ts";
import { emptyOperationMeasurements, runtimeFailure, type OperationMeta, type RuntimeResult } from "../core/result.ts";
import { DEFAULT_RUNTIME_BUDGETS, narrowBudget } from "../policy/budgets.ts";
import { Tracer } from "../observability/tracer.ts";
import type {
  DockerSandboxProviderOptions,
  SandboxCapabilities,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxProvider,
  SbxCli,
  SbxCliResult,
  WorkspaceMode,
} from "./types.ts";

const DEFAULT_SETUP_ACTION = "Run `sbx setup` interactively, then retry the runtime operation.";
const SBX_PROBE_TIMEOUT_MS = 2_000;

function defaultCli(): SbxCli {
  return {
    run(args, options = {}) {
      const result = spawnSync("sbx", [...args], {
        encoding: "utf8",
        timeout: options.timeoutMs ?? SBX_PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { CI: "1", DOCKER_CLI_HINTS: "false" },
      } as unknown as Parameters<typeof spawnSync>[2]);
      return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: `${typeof result.stderr === "string" ? result.stderr : ""}${result.error === undefined ? "" : ` ${result.error.message}`}`.trim(),
        exitCode: result.status,
        timedOut: (result.error as Error & { readonly code?: string } | undefined)?.code === "ETIMEDOUT",
      };
    },
  };
}

export function fullAlphaSandboxCapabilities(provider: string, overrides: Partial<SandboxCapabilities> = {}): SandboxCapabilities {
  const features = overrides.features ?? { pauseResume: false, checkpoint: false, snapshot: false, fork: false, clone: false, resourceLimits: false };
  const isolationType = overrides.isolationType ?? "unknown";
  const workspaceMode = overrides.workspaceMode ?? "unknown";
  const credentialSupport = overrides.credentialSupport ?? "unknown";
  return {
    provider,
    state: overrides.state ?? "unavailable",
    setupRequired: overrides.setupRequired ?? (overrides.state === "available_requires_setup"),
    isolationType,
    isolation: overrides.isolation ?? isolationType,
    workspaceMode,
    workspaceModes: overrides.workspaceModes ?? [workspaceMode],
    persistence: overrides.persistence ?? "unknown",
    pauseResume: overrides.pauseResume ?? features.pauseResume,
    checkpoint: overrides.checkpoint ?? features.checkpoint,
    snapshot: overrides.snapshot ?? features.snapshot,
    fork: overrides.fork ?? features.fork,
    clone: overrides.clone ?? features.clone,
    networkControl: overrides.networkControl ?? "unknown",
    resourceLimits: overrides.resourceLimits ?? features.resourceLimits,
    credentialSupport,
    credentials: credentialSupport,
    secrets: credentialSupport,
    features,
    ...(overrides.setupAction === undefined ? {} : { setupAction: overrides.setupAction }),
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
  };
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker-sbx" as const;
  private readonly cli: SbxCli;
  private readonly tracer: Tracer;
  private readonly setupAction: string;
  private readonly maxOutputBytes: number;
  private readonly detectionTimeoutMs: number;
  private detected: SandboxCapabilities | undefined;

  constructor(options: DockerSandboxProviderOptions = {}) {
    this.cli = options.cli ?? defaultCli();
    this.tracer = options.tracer ?? new Tracer();
    this.setupAction = options.setupAction ?? DEFAULT_SETUP_ACTION;
    this.maxOutputBytes = narrowBudget(options.maxOutputBytes, DEFAULT_RUNTIME_BUDGETS.maxOutputBytes, "maxOutputBytes");
    this.detectionTimeoutMs = options.detectionTimeoutMs ?? SBX_PROBE_TIMEOUT_MS;
  }

  async capabilities(): Promise<SandboxCapabilities> {
    // Setup may be completed by the operator between attempts; do not turn a
    // setup-required observation into a permanent provider state.
    if (this.detected !== undefined && this.detected.state !== "available_requires_setup") return this.detected;
    let version: SbxCliResult;
    try { version = await this.cli.run(["--version"], { timeoutMs: this.detectionTimeoutMs }); }
    catch (cause) {
      return this.detected = fullAlphaSandboxCapabilities(this.name, { state: "unavailable", reason: cause instanceof Error ? cause.message : "sbx CLI is unavailable" });
    }
    if (version.exitCode !== 0 || version.timedOut) {
      const missing = /ENOENT|not found|no such file/i.test(`${version.stderr} ${version.stdout}`);
      return this.detected = fullAlphaSandboxCapabilities(this.name, { state: "unavailable", reason: missing ? "The standalone sbx CLI is not installed" : "The standalone sbx CLI could not be executed" });
    }
    let status: SbxCliResult;
    try { status = await this.cli.run(["ls", "--non-interactive"], { timeoutMs: this.detectionTimeoutMs }); }
    catch (cause) {
      return this.detected = this.setupRequired(cause instanceof Error ? cause.message : "sbx setup has not completed");
    }
    if (status.exitCode !== 0 || status.timedOut) return this.detected = this.setupRequired(status.stderr.trim() || "sbx setup has not completed");
    return this.detected = this.readyCapabilities();
  }

  async execute(request: SandboxExecutionRequest, context: OperationContext): Promise<RuntimeResult<SandboxExecutionResult>> {
    const effectClass = request.effectClass ?? "destructive";
    const evidence = policyDecisionEvidence(context.effectPolicy, effectClass);
    if (evidence.decision !== "allow") return sandboxPolicyFailure(context, this.name, effectClass, evidence);
    const requestBytes = byteLength(JSON.stringify(request) ?? String(request));
    if (requestBytes > context.budgets.maxInputBytes) {
      const error = createRuntimeError({ code: "SANDBOX_INPUT_TOO_LARGE", message: "Sandbox execution input exceeds the runtime budget", retryable: false, effect: "none", details: { inputBytes: requestBytes, maxInputBytes: context.budgets.maxInputBytes } });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    if (isDeadlineExceeded(context)) {
      const error = createRuntimeError({ code: "SANDBOX_TIMEOUT", message: "sbx execution exceeded its bounded deadline", retryable: true, effect: "none" });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    const capabilities = await this.capabilities();
    if (capabilities.state !== "ready") {
      const error = createRuntimeError({
        code: capabilities.state === "available_requires_setup" ? "SANDBOX_SETUP_REQUIRED" : "SANDBOX_UNAVAILABLE",
        message: capabilities.state === "available_requires_setup" ? (capabilities.setupAction ?? this.setupAction) : (capabilities.reason ?? "The sbx provider is unavailable"),
        retryable: false,
        effect: "none",
        details: { provider: this.name, state: capabilities.state, ...(capabilities.setupAction === undefined ? {} : { setupAction: capabilities.setupAction }) },
      });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    if (request.workspaceMode !== undefined && !capabilities.workspaceModes.includes(request.workspaceMode)) {
      const error = createRuntimeError({ code: "SANDBOX_WORKSPACE_UNSUPPORTED", message: `The ${this.name} provider does not support workspace mode ${request.workspaceMode}`, retryable: false, effect: "none", details: { provider: this.name, workspaceMode: request.workspaceMode } });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    // Agent-authored mutations should get the strongest workspace isolation
    // this provider advertises unless the caller explicitly selected a mode.
    const workspaceMode = request.workspaceMode ?? (
      (effectClass === "workspace_write" || effectClass === "destructive") && capabilities.workspaceModes.includes("private_clone")
        ? "private_clone"
        : capabilities.workspaceMode
    );
    const args = ["run", "--non-interactive", "--workspace-mode", workspaceMode, "--"];
    if (request.executable !== undefined) args.push(request.executable, ...(request.args ?? []));
    else args.push("sh", "-lc", request.command ?? "");
    let result: SbxCliResult;
    const deadlineRemaining = context.deadline === undefined ? DEFAULT_RUNTIME_BUDGETS.maxExecutionMs : Math.max(0, context.deadline - Date.now());
    if (deadlineRemaining <= 0) {
      const error = createRuntimeError({ code: "SANDBOX_TIMEOUT", message: "sbx execution exceeded its bounded deadline", retryable: true, effect: "unknown" });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    try { result = await this.cli.run(args, { timeoutMs: Math.min(request.timeoutMs ?? DEFAULT_RUNTIME_BUDGETS.maxExecutionMs, context.budgets.maxExecutionMs, deadlineRemaining) }); }
    catch (cause) {
      const error = createRuntimeError({ code: "SANDBOX_EXECUTION_FAILED", message: cause instanceof Error ? cause.message : "sbx execution failed", retryable: false, effect: "unknown" });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    const max = narrowBudget(request.maxOutputBytes, Math.min(this.maxOutputBytes, context.budgets.maxOutputBytes, Math.floor(context.budgets.maxReturnedOutputBytes / 2)), "maxOutputBytes");
    const stdout = bounded(result.stdout, max);
    const stderr = bounded(result.stderr, max);
    const rawOutputBytes = byteLength(result.stdout) + byteLength(result.stderr);
    const data: SandboxExecutionResult = {
      provider: this.name,
      isolationType: "container",
      workspaceMode,
      status: result.exitCode === 0 ? "completed" : result.timedOut ? "cancelled" : "failed",
      effectState: result.exitCode === 0 ? (effectClass === "read" ? "none" : "applied") : result.timedOut ? "unknown" : "none",
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdout,
      stderr,
      rawOutputBytes,
      returnedOutputBytes: byteLength(stdout) + byteLength(stderr),
      truncated: stdout !== result.stdout || stderr !== result.stderr,
      ...(result.timedOut ? { error: "sbx execution exceeded its bounded deadline" } : {}),
    };
    if (data.status !== "completed") {
      const error = createRuntimeError({ code: data.status === "cancelled" ? "SANDBOX_TIMEOUT" : "SANDBOX_EXECUTION_FAILED", message: data.error ?? "sbx execution failed", retryable: data.status === "cancelled", effect: data.status === "cancelled" ? "unknown" : "none" });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    return {
      ok: true,
      data,
      meta: sandboxExecutionMeta(context, this.name, effectClass, undefined, data),
    };
  }

  private setupRequired(reason: string): SandboxCapabilities {
    return fullAlphaSandboxCapabilities(this.name, { state: "available_requires_setup", setupAction: this.setupAction, reason });
  }

  private readyCapabilities(): SandboxCapabilities {
    return fullAlphaSandboxCapabilities(this.name, {
      state: "ready",
      isolationType: "container",
      workspaceMode: "host",
      workspaceModes: ["host", "private_clone"],
      persistence: "checkpointed",
      pauseResume: false,
      checkpoint: true,
      snapshot: true,
      fork: true,
      clone: true,
      networkControl: "allow_deny",
      resourceLimits: true,
      credentialSupport: "named_grants",
      features: { pauseResume: false, checkpoint: true, snapshot: true, fork: true, clone: true, resourceLimits: true },
    });
  }
}

export const DockerSbxProvider = DockerSandboxProvider;
export const SbxProvider = DockerSandboxProvider;

/** Capability detection is safe to call on hosts without `sbx`. */
export function detectSbxCli(options: DockerSandboxProviderOptions = {}): Promise<SandboxCapabilities> {
  return new DockerSandboxProvider(options).capabilities();
}

function sandboxPolicyFailure(context: OperationContext, provider: string, effectClass: EffectClass, evidence: ReturnType<typeof policyDecisionEvidence>): RuntimeResult<never> {
  const error = createRuntimeError({ code: evidence.decision === "approval_required" ? "EFFECT_APPROVAL_REQUIRED" : "EFFECT_NOT_ALLOWED", message: evidence.reason, retryable: false, effect: "none", details: { provider, ...evidence } });
  return sandboxExecutionFailure(error, sandboxExecutionMeta(context, provider, effectClass, undefined, undefined, evidence));
}

export function sandboxExecutionMeta(context: OperationContext, provider: string, effectClass: EffectClass, original?: OperationMeta, result?: SandboxExecutionResult, evidence = policyDecisionEvidence(context.effectPolicy, effectClass)): OperationMeta {
  return {
    ...(original ?? {
      traceId: context.traceId,
      runId: context.runId,
      spanId: context.spanId ?? "span_uninstrumented" as import("../core/ids.ts").SpanId,
      operation: "sandbox.run",
      status: result?.status === "completed" ? "completed" : "failed",
      startedAt: new Date().toISOString(),
      effectClass,
      effectState: result?.effectState ?? "none",
      artifactRefs: [],
      metrics: { ...emptyOperationMeasurements(), rawOutputBytes: result?.rawOutputBytes ?? 0, returnedOutputBytes: result?.returnedOutputBytes ?? 0 },
      truncated: result?.truncated ?? false,
    }),
    operation: "sandbox.run",
    policyDecision: evidence.decision,
    policyEvidence: evidence,
    provider,
  };
}

export function sandboxExecutionFailure(error: import("../core/result.ts").RuntimeError, meta: OperationMeta): RuntimeResult<never> {
  return runtimeFailure(error, meta);
}

function bounded(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= maxBytes ? value : new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
