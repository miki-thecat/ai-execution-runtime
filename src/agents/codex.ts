import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { env as parentEnvironment } from "node:process";
import type { RunId } from "../core/ids.ts";
import { createSpanId, createRuntimeError, isDeadlineExceeded, type OperationContext, type RuntimeError } from "../core/index.ts";
import { credentialGrant, effectDecision, type EffectClass, type EffectState, type EffectPolicy } from "../core/effects.ts";
import { FileArtifactStore, type ArtifactStore } from "../artifacts/store.ts";
import { ensureTracerEventsPersisted } from "../project/events.ts";
import type { ProjectIdentity } from "../project/types.ts";
import { Tracer } from "../observability/tracer.ts";
import type { RuntimeEvent } from "../observability/events.ts";
import type { RuntimeStatus } from "../core/result.ts";
import type { StateStore } from "../state/store.ts";
import { TaskManager } from "../tasks/index.ts";
import { CodexJsonlParser } from "./jsonl.ts";
import { linkedWorktreeCommonDir } from "./git-metadata.ts";
import {
  createAgentRunId,
  DEFAULT_AGENT_ACTOR,
  type AgentCapabilities,
  type AgentChildProcess,
  type AgentExecutor,
  type AgentMetrics,
  type AgentRun,
  type AgentRunId,
  type AgentSpawn,
  type AgentSpawnOptions,
  type AgentTask,
  type CapabilityPosture,
  type CodexCapabilityProbe,
  type CodexEnvironmentOptions,
  type CodexExecutorOptions,
  type CredentialClassifier,
  type CredentialEvidence,
  type EnvironmentEvidence,
  type ParsedCodexJsonl,
} from "./types.ts";

const PROVIDER = "codex" as const;
const EXECUTOR = "agent" as const;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 32 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 250;
const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 2_000;
const SAFE_BASELINE_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "CI",
] as const;
const SAFE_ORDINARY_ENVIRONMENT = /^(?:SHELL|HOSTNAME|LANGUAGE|TZ|COLORTERM|FORCE_COLOR|CONTINUOUS_INTEGRATION|AER_[A-Z0-9_]+|ACP_[A-Z0-9_]+)$/i;
const REQUIRED_FLAGS = ["--json", "--sandbox", "--ignore-user-config", "--ignore-rules", "--disable", "--config"] as const;
const KNOWN_FLAGS = [...REQUIRED_FLAGS, "--ask-for-approval", "--color", "--ephemeral", "--config", "--skip-git-repo-check"] as const;
// Keep this aligned with the controller worker posture: delegated AER agents
// need repository shell/file capabilities, not ambient connected surfaces.
const DISABLED_CONNECTED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "image_generation",
  "multi_agent",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "skill_search",
] as const;
const DEFAULT_CREDENTIAL_CLASSIFIERS: readonly CredentialClassifier[] = [
  { name: "token", pattern: /token/i },
  { name: "secret", pattern: /secret/i },
  { name: "password", pattern: /pass(word)?/i },
  { name: "api_key", pattern: /api[_-]?key|apikey/i },
  { name: "credential", pattern: /credential|auth/i },
  { name: "private_key", pattern: /private[_-]?key/i },
  { name: "cookie", pattern: /cookie/i },
  { name: "github_credential", pattern: /^GH_|GITHUB_|github/i },
  { name: "cloud_credential", pattern: /^(AWS|AZURE|GOOGLE|GCLOUD|CLOUD)_/i },
  { name: "cluster_credential", pattern: /KUBECONFIG|KUBE_/i },
  { name: "database_credential", pattern: /DATABASE_URL|DB_PASSWORD/i },
  { name: "credential_file", pattern: /NPM_CONFIG_USERCONFIG|GIT_ASKPASS|NETRC|SSH_AUTH_SOCK|DOCKER_CONFIG|APPLICATION_CREDENTIALS/i },
];

interface ProbeResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
}

interface ActiveAgent {
  readonly process: AgentChildProcess;
  readonly runId: RunId;
  complete: Promise<void>;
  cancelRequested: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

interface BuiltEnvironment {
  readonly values: Readonly<Record<string, string | undefined>>;
  readonly evidence: EnvironmentEvidence;
}

interface PreparedExecution {
  readonly project: ProjectIdentity;
  readonly executable: string;
  readonly prompt: string;
  readonly args: readonly string[];
  readonly environment: BuiltEnvironment;
  readonly posture: CapabilityPosture;
  readonly effectClass: EffectClass;
  readonly capabilities: AgentCapabilities;
}

function defaultSpawn(executable: string, args: readonly string[], options: AgentSpawnOptions): AgentChildProcess {
  return spawn(executable, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as AgentChildProcess;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bounded(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  if (maxBytes <= 3) return new TextDecoder().decode(bytes.slice(0, maxBytes));
  return `${new TextDecoder().decode(bytes.slice(0, Math.max(0, maxBytes - 3)))}…`;
}

function versionOf(output: string): string | undefined {
  const match = output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0];
}

function resolvedExecutable(executable: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const candidates = isAbsolute(executable) || executable.includes("/")
    ? [resolve(executable)]
    : (environment.PATH ?? "").split(":").filter(Boolean).map((entry) => resolve(entry, executable));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

function connectedFeatureArgs(): string[] {
  return DISABLED_CONNECTED_FEATURES.flatMap((feature) => ["--disable", feature]);
}

function connectedSuppressionProven(output: string): boolean {
  const states = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 3) states.set(fields[0]!, fields.at(-1)!);
  }
  return DISABLED_CONNECTED_FEATURES.every((feature) => states.get(feature) === "false");
}

function permissionProfileArgs(executableDir: string, workspaceAccess: "read" | "write", network: boolean, gitCommonDir?: string): string[] {
  const readRoots = [...new Set([executableDir, ...(gitCommonDir === undefined ? [] : [gitCommonDir])])];
  const filesystem = `{":minimal"="read",":workspace_roots"="${workspaceAccess}",${readRoots.map((path) => `${JSON.stringify(path)}="read"`).join(",")}}`;
  return [
    "--config", 'default_permissions="aer_worker"',
    "--config", `permissions.aer_worker.filesystem=${filesystem}`,
    "--config", `permissions.aer_worker.network={enabled=${network ? "true" : "false"}}`,
    "--config", 'web_search="disabled"',
  ];
}

function flagsFromHelp(output: string): readonly string[] {
  return KNOWN_FLAGS.filter((flag) => new RegExp(`(^|\\s)${flag.replaceAll("-", "\\-")}(?:[=,\\s]|$)`).test(output));
}

function capabilityPosture(
  network: CapabilityPosture["network"] = "unavailable",
  sandbox: CapabilityPosture["sandbox"] = "read-only",
  connected: "suppressed" | "unavailable" = "unavailable",
): CapabilityPosture {
  return {
    userConfig: "ignored",
    execPolicy: "ignored",
    sandbox,
    approval: "never",
    apps: connected,
    plugins: connected,
    hooks: connected,
    browser: connected,
    computerUse: connected,
    remotePlugins: connected,
    multiAgent: connected,
    network,
  };
}

function credentialClass(key: string, classifiers: readonly CredentialClassifier[]): string | undefined {
  return classifiers.find((classifier) => classifier.pattern.test(key))?.name;
}

function evidenceEntry(key: string, classifiers: readonly CredentialClassifier[]): CredentialEvidence | undefined {
  const classification = credentialClass(key, classifiers);
  return classification === undefined ? undefined : { key, class: classification };
}

function environmentFor(options: CodexEnvironmentOptions | undefined, policy?: EffectPolicy): BuiltEnvironment {
  const input = options ?? {};
  const classifiers = [...DEFAULT_CREDENTIAL_CLASSIFIERS, ...(input.credentialClassifiers ?? [])];
  const values: Record<string, string | undefined> = {};
  const parent = parentEnvironment;
  for (const key of SAFE_BASELINE_KEYS) {
    if (parent[key] !== undefined) values[key] = parent[key];
  }
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && SAFE_ORDINARY_ENVIRONMENT.test(key) && credentialClass(key, classifiers) === undefined) values[key] = value;
  }
  for (const key of [...(input.passThroughKeys ?? []), ...(input.allowedEnvironmentKeys ?? [])]) {
    if (parent[key] !== undefined && (credentialClass(key, classifiers) === undefined || credentialGrant(policy, key, "agent.run") !== undefined)) values[key] = parent[key];
  }
  for (const key of [...(input.providerKeys ?? []), ...(input.providerRequiredKeys ?? [])]) {
    if (parent[key] !== undefined && (credentialClass(key, classifiers) === undefined || credentialGrant(policy, key, "agent.run") !== undefined)) values[key] = parent[key];
  }
  for (const [key, value] of Object.entries({ ...(input.safeVariables ?? {}), ...(input.variables ?? {}) })) {
    if (credentialClass(key, classifiers) !== undefined && credentialGrant(policy, key, "agent.run") === undefined) continue;
    values[key] = value;
  }
  const providerHome = input.codexHome ?? input.providerHome;
  if (providerHome !== undefined) {
    if (!existsSync(providerHome)) mkdirSync(providerHome, { recursive: true, mode: 0o700 });
    values.CODEX_HOME = providerHome;
  }
  const granted: CredentialEvidence[] = [];
  for (const key of Object.keys(values)) {
    const item = evidenceEntry(key, classifiers);
    if (item !== undefined) granted.push(item);
  }
  const withheld: CredentialEvidence[] = [];
  for (const key of Object.keys(parent)) {
    if (values[key] !== undefined) continue;
    const item = evidenceEntry(key, classifiers);
    if (item !== undefined) withheld.push(item);
  }
  return {
    values,
    evidence: {
      baselineKeys: SAFE_BASELINE_KEYS.filter((key) => values[key] !== undefined),
      granted: granted.sort((left, right) => left.key.localeCompare(right.key)),
      withheld: withheld.sort((left, right) => left.key.localeCompare(right.key)),
      valueLogging: "disabled",
    },
  };
}

function inputFor(task: AgentTask): string {
  const prompt = task.prompt ?? task.input ?? task.goal ?? task.title;
  if (prompt === undefined || prompt.trim() === "") throw createRuntimeError({ code: "AGENT_INPUT_EMPTY", message: "Agent task input is empty", retryable: false, effect: "none" });
  return prompt;
}

function errorFor(cause: unknown, code: string, effect: EffectState = "none"): RuntimeError {
  if (cause !== null && typeof cause === "object" && "code" in cause && "message" in cause && "effect" in cause) return cause as RuntimeError;
  return createRuntimeError({ code, message: cause instanceof Error ? cause.message : code, retryable: false, effect });
}

function statusForTerminal(terminal: AgentRun["terminalState"]): AgentRun["status"] {
  if (terminal === "completed") return "completed";
  if (terminal === "cancelled") return "cancelled";
  if (terminal === "incomplete" || terminal === "contradictory") return "unknown";
  return "failed";
}

function terminalError(terminal: AgentRun["terminalState"], code: number | null, signal: string | null): RuntimeError | undefined {
  if (terminal === "completed") return undefined;
  if (terminal === "cancelled") return createRuntimeError({ code: "AGENT_CANCELLED", message: "Codex execution was cancelled", retryable: false, effect: "unknown" });
  if (terminal === "contradictory") return createRuntimeError({ code: "AGENT_STRUCTURED_STATE_CONTRADICTORY", message: "Codex reported contradictory terminal states", retryable: false, effect: "unknown" });
  if (terminal === "incomplete") return createRuntimeError({ code: "AGENT_TERMINAL_STATE_INCOMPLETE", message: "Codex did not report a complete terminal turn", retryable: false, effect: "unknown", details: { exitCode: code, signal } });
  return createRuntimeError({ code: "AGENT_PROCESS_FAILED", message: "Codex execution failed", retryable: false, effect: "unknown", details: { exitCode: code, signal } });
}

function asMeasurements(metrics: AgentMetrics): Partial<import("../core/result.ts").OperationMeasurements> {
  return {
    durationMs: metrics.durationMs,
    inputBytes: metrics.inputBytes,
    rawOutputBytes: metrics.rawOutputBytes,
    returnedOutputBytes: metrics.returnedOutputBytes,
    artifactBytes: metrics.artifactBytes,
    internalCalls: metrics.commandCount + metrics.toolCallCount,
    retries: metrics.retries,
    ...(metrics.exitCode === undefined ? {} : { exitCode: metrics.exitCode }),
    ...(metrics.signal === undefined ? {} : { signal: metrics.signal }),
    ...(metrics.usage?.inputTokens === undefined ? {} : { tokenInput: metrics.usage.inputTokens }),
    ...(metrics.usage?.outputTokens === undefined ? {} : { tokenOutput: metrics.usage.outputTokens }),
    ...(metrics.usage?.cachedInputTokens === undefined ? {} : { tokenCached: metrics.usage.cachedInputTokens }),
  };
}

/** Full Alpha's bounded, non-interactive Codex `exec --json` adapter. */
export class CodexAgentExecutor implements AgentExecutor {
  readonly tracer: Tracer;
  readonly provider = PROVIDER;
  private readonly executable: string;
  private resolvedExecutablePath: string | undefined;
  private readonly registry: CodexExecutorOptions["registry"];
  private readonly state: StateStore | undefined;
  private readonly artifacts: ArtifactStore;
  private readonly spawnProcess: AgentSpawn;
  private readonly environmentOptions: CodexEnvironmentOptions | undefined;
  private readonly maxOutputBytes: number;
  private readonly maxInputBytes: number;
  private readonly cancelGraceMs: number;
  private readonly captureTranscript: boolean;
  private readonly transcriptSensitivity: NonNullable<CodexExecutorOptions["transcriptSensitivity"]>;
  private readonly grantNetwork: boolean;
  private readonly tasks: TaskManager | undefined;
  private readonly active = new Map<AgentRunId, ActiveAgent>();
  private capabilityPromise: Promise<AgentCapabilities> | undefined;

  constructor(options: CodexExecutorOptions = {}) {
    this.tracer = options.tracer ?? new Tracer(options.state === undefined ? {} : { sink: options.state });
    ensureTracerEventsPersisted(this.tracer, options.state);
    this.executable = options.executable ?? "codex";
    this.registry = options.registry;
    this.state = options.state;
    this.artifacts = options.artifacts ?? new FileArtifactStore(options.state === undefined ? {} : { state: options.state });
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.environmentOptions = options.environment;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.captureTranscript = options.captureTranscript ?? false;
    this.transcriptSensitivity = options.transcriptSensitivity ?? "sensitive";
    this.grantNetwork = options.grantNetwork ?? false;
    this.tasks = options.tasks ?? (options.state === undefined ? undefined : new TaskManager({ state: options.state, tracer: this.tracer }));
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 0) throw new RangeError("maxOutputBytes must be a non-negative integer");
    if (!Number.isSafeInteger(this.maxInputBytes) || this.maxInputBytes < 1) throw new RangeError("maxInputBytes must be a positive integer");
    if (!Number.isSafeInteger(this.cancelGraceMs) || this.cancelGraceMs < 0) throw new RangeError("cancelGraceMs must be a non-negative integer");
  }

  capabilities(context?: OperationContext): Promise<AgentCapabilities> {
    this.capabilityPromise ??= this.detectCapabilities(context);
    return this.capabilityPromise;
  }

  async run(task: AgentTask, context: OperationContext): Promise<AgentRun> {
    const agentRunId = createAgentRunId();
    const startedAt = this.tracer.now().toISOString();
    let project: ProjectIdentity | undefined;
    let environment = environmentFor(this.environmentOptions, context.effectPolicy);
    let posture = capabilityPosture();
    let effectClass: EffectClass = "read";
    let prompt = "";
    try {
      project = this.resolveProject(task, context);
      prompt = inputFor(task);
      const maxInputBytes = Math.min(this.maxInputBytes, context.budgets.maxInputBytes);
      if (byteLength(prompt) > maxInputBytes) throw createRuntimeError({ code: "AGENT_INPUT_TOO_LARGE", message: "Agent task input exceeds the configured bound", retryable: false, effect: "none", details: { maxInputBytes } });
      if (task.workspace !== undefined && realpathSync(resolve(task.workspace)) !== project.rootDir) throw createRuntimeError({ code: "AGENT_WORKSPACE_NOT_CANONICAL", message: "Agent workspace must be the registered project root", retryable: false, effect: "none" });
      const prepared = await this.prepare(task, context, project, prompt, environment);
      environment = prepared.environment;
      posture = prepared.posture;
      effectClass = prepared.effectClass;
      const queued: AgentRun = { ...this.baseRun(agentRunId, task, context, "failed", "incomplete", "none", startedAt, startedAt, "", "Agent execution was not started", this.emptyMetrics(byteLength(prompt), false), posture, environment.evidence, [], undefined, undefined), capabilitySnapshot: prepared.capabilities };
      this.persistAgent(queued, "queued");
      if (context.signal.aborted || isDeadlineExceeded(context)) return this.finishWithoutProcess(queued, "cancelled", createRuntimeError({ code: "AGENT_CANCELLED", message: "Agent execution was cancelled before spawn", retryable: false, effect: "none" }));
      this.persistAgent(queued, "running");
      this.emitAgent("agent.started", queued, "running", effectClass, "Agent execution started");
      if (this.tasks?.get(task.taskId) !== undefined) this.tasks.start(task.taskId, { reason: "Delegated to Codex" }, context);
      return await this.execute(agentRunId, task, context, prepared, startedAt);
    } catch (cause) {
      const error = errorFor(cause, "AGENT_PREPARATION_FAILED");
      const failed = this.baseRun(agentRunId, task, context, "failed", "failed", error.effect, startedAt, this.tracer.now().toISOString(), "", error.message, this.emptyMetrics(prompt === "" ? 0 : byteLength(prompt), false), posture, environment.evidence, [], undefined, error);
      this.persistAgent(failed, "failed");
      this.emitAgent("agent.failed", failed, "failed", effectClass, error.message, error);
      if (this.tasks !== undefined && this.tasks.get(task.taskId)?.status === "running") this.tasks.fail(task.taskId, { reason: error.code }, context);
      return failed;
    }
  }

  async cancel(agentRunId: AgentRunId | string): Promise<void> {
    const active = this.active.get(agentRunId as AgentRunId) ?? [...this.active.values()].find((candidate) => candidate.runId === agentRunId);
    if (active === undefined) return;
    active.cancelRequested = true;
    active.process.kill("SIGTERM");
    active.cancelTimer = setTimeout(() => { active.process.kill("SIGKILL"); }, this.cancelGraceMs);
    await active.complete;
  }

  private async detectCapabilities(context?: OperationContext): Promise<AgentCapabilities> {
    const detectedAt = this.tracer.now().toISOString();
    const environment = environmentFor(this.environmentOptions);
    const executable = resolvedExecutable(this.executable, environment.values);
    if (executable === undefined) return this.capabilityResult(detectedAt, undefined, [], "unsupported", ["codex executable is unavailable"], false);
    this.resolvedExecutablePath = executable;
    let versionProbe: ProbeResult;
    try { versionProbe = await this.probe(executable, ["--version"], environment.values, context); }
    catch { return this.capabilityResult(detectedAt, undefined, [], "unsupported", ["codex executable is unavailable"], false); }
    const installedVersion = versionOf(versionProbe.stdout);
    let help: ProbeResult;
    try { help = await this.probe(executable, ["exec", "--help"], environment.values, context); }
    catch { help = { code: null, signal: null, stdout: "" }; }
    const supportedFlags = flagsFromHelp(help.stdout);
    let suppressionProven = false;
    if (supportedFlags.includes("--disable")) {
      try {
        const featureProbe = await this.probe(executable, ["features", ...connectedFeatureArgs(), "list"], environment.values, context);
        suppressionProven = featureProbe.code === 0 && connectedSuppressionProven(featureProbe.stdout);
      } catch { suppressionProven = false; }
    }
    let appServer: CodexCapabilityProbe["appServer"] = "unsupported";
    try {
      const appHelp = await this.probe(executable, ["app-server", "--help"], environment.values, context);
      appServer = appHelp.code === 0 ? "available" : "unsupported";
    } catch { appServer = "unsupported"; }
    const missing = REQUIRED_FLAGS.filter((flag) => !supportedFlags.includes(flag));
    const hasNeverApprovalControl = supportedFlags.includes("--ask-for-approval") || supportedFlags.includes("--config");
    const incompatibilities = [
      ...(versionProbe.code !== 0 ? ["codex --version did not complete successfully"] : []),
      ...(installedVersion === undefined ? ["installed Codex version could not be determined"] : []),
      ...(help.code !== 0 ? ["codex exec --help did not complete successfully"] : []),
      ...(missing.length === 0 ? [] : [`required automation flags are unavailable: ${missing.join(", ")}`]),
      ...(hasNeverApprovalControl ? [] : ["installed Codex cannot enforce non-interactive approval_policy=never"]),
      ...(suppressionProven ? [] : ["connected Codex feature suppression could not be proven"]),
    ];
    return this.capabilityResult(detectedAt, installedVersion, supportedFlags, appServer, incompatibilities, suppressionProven);
  }

  private capabilityResult(
    detectedAt: string,
    installedVersion: string | undefined,
    supportedFlags: readonly string[],
    appServer: CodexCapabilityProbe["appServer"],
    incompatibilities: readonly string[],
    suppressionProven = false,
  ): AgentCapabilities {
    const compatible = incompatibilities.length === 0;
    const capabilities = {
      resume: false,
      streaming: supportedFlags.includes("--json"),
      approval: false,
      structured_output: supportedFlags.includes("--json"),
      sandbox: supportedFlags.includes("--sandbox"),
      network_policy: supportedFlags.includes("--config"),
      remote: false,
    } as const;
    const supportedCapabilities = Object.entries(capabilities).filter(([, value]) => value).map(([key]) => key as keyof typeof capabilities);
    return {
      executor: EXECUTOR,
      provider: PROVIDER,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedVersion === undefined ? {} : { version: installedVersion }),
      detectedAt,
      compatible,
      capabilities,
      supportedCapabilities: [...supportedCapabilities, ...(appServer === "available" ? ["app_server" as const] : [])],
      appServer,
      requiredIsolation: ["ignore-user-config", "ignore-rules", "disable-connected-surfaces"],
      supportedIsolation: [
        ...supportedFlags.filter((flag) => flag === "--ignore-user-config" || flag === "--ignore-rules").map((flag) => flag.slice(2)),
        ...(suppressionProven ? ["disable-connected-surfaces"] : []),
      ],
      supportedAutomationFlags: supportedFlags,
      incompatibilities,
      capabilityPosture: capabilityPosture(
        supportedFlags.includes("--config") ? "suppressed" : "unavailable",
        "read-only",
        suppressionProven ? "suppressed" : "unavailable",
      ),
    };
  }

  private resolveProject(task: AgentTask, context: OperationContext): ProjectIdentity {
    if (this.registry === undefined) throw createRuntimeError({ code: "AGENT_PROJECT_REGISTRY_REQUIRED", message: "Codex execution requires the canonical AER project registry", retryable: false, effect: "none" });
    if (context.projectId !== undefined && context.projectId !== task.projectId) throw createRuntimeError({ code: "AGENT_PROJECT_MISMATCH", message: "Agent task project does not match its operation context", retryable: false, effect: "none" });
    if (context.taskId !== undefined && context.taskId !== task.taskId) throw createRuntimeError({ code: "AGENT_TASK_MISMATCH", message: "Agent task does not match its operation context", retryable: false, effect: "none" });
    if (context.runId !== task.runId) throw createRuntimeError({ code: "AGENT_RUN_MISMATCH", message: "Agent task run does not match its operation context", retryable: false, effect: "none" });
    const project = this.registry.get(task.projectId);
    if (project === undefined) throw createRuntimeError({ code: "PROJECT_NOT_FOUND", message: "Agent project is not registered", retryable: false, effect: "none" });
    if (project.boundary.root.status !== "trusted") throw createRuntimeError({ code: "PROJECT_ROOT_UNTRUSTED", message: project.boundary.root.code ?? "Registered project root is not trusted", retryable: false, effect: "none" });
    if (project.boundary.identity.status !== "trusted") throw createRuntimeError({ code: "PROJECT_IDENTITY_UNTRUSTED", message: project.boundary.identity.code ?? "Registered project identity is not trusted", retryable: false, effect: "none" });
    const durableTask = this.state?.getTask(task.taskId);
    if (durableTask !== undefined && (durableTask.projectId !== task.projectId || durableTask.runId !== task.runId)) throw createRuntimeError({ code: "AGENT_TASK_NOT_CANONICAL", message: "Agent task is not linked to the requested project and run", retryable: false, effect: "none" });
    return project;
  }

  private async prepare(task: AgentTask, context: OperationContext, project: ProjectIdentity, prompt: string, environment: BuiltEnvironment): Promise<PreparedExecution> {
    if (context.signal.aborted || isDeadlineExceeded(context)) throw createRuntimeError({ code: "AGENT_CANCELLED", message: "Agent execution was cancelled before capability probing", retryable: false, effect: "none" });
    const readDecision = effectDecision(context.effectPolicy, "read");
    if (readDecision === "deny") throw createRuntimeError({ code: "AGENT_EFFECT_DENIED", message: "AER policy does not allow the agent to read the project", retryable: false, effect: "none" });
    if (readDecision === "approval_required") throw createRuntimeError({ code: "AGENT_APPROVAL_REQUIRED_NONINTERACTIVE", message: "Project reads require approval and Codex execution is unattended", retryable: false, effect: "none" });
    const canWrite = effectDecision(context.effectPolicy, "workspace_write") === "allow";
    const canNetwork = effectDecision(context.effectPolicy, "network") === "allow";
    if (effectDecision(context.effectPolicy, "workspace_write") === "approval_required") throw createRuntimeError({ code: "AGENT_APPROVAL_REQUIRED_NONINTERACTIVE", message: "Workspace writes require approval and Codex execution is unattended", retryable: false, effect: "none" });
    if (this.grantNetwork && !canNetwork) throw createRuntimeError({ code: "AGENT_NETWORK_POLICY_DENIED", message: "Network access was requested but denied by AER policy", retryable: false, effect: "none" });
    // Policy and the caller's bounded context are checked before any provider
    // executable is probed. A broken/unresponsive installation cannot turn a
    // denied or expired agent operation into an unbounded preflight.
    const capabilities = await this.capabilities(context);
    if (context.signal.aborted || isDeadlineExceeded(context)) throw createRuntimeError({ code: "AGENT_CANCELLED", message: "Agent execution was cancelled during capability probing", retryable: false, effect: "none" });
    if (!capabilities.compatible) throw createRuntimeError({ code: "AGENT_INCOMPATIBLE", message: "Installed Codex cannot provide the required isolated non-interactive contract", retryable: false, effect: "none", details: { reasons: capabilities.incompatibilities } });
    const sandbox = canWrite ? "workspace-write" : "read-only";
    const network = this.grantNetwork && canNetwork;
    const executable = this.resolvedExecutablePath ?? resolvedExecutable(this.executable, environment.values);
    if (executable === undefined) throw createRuntimeError({ code: "AGENT_EXECUTABLE_UNRESOLVED", message: "Codex executable path cannot be resolved for the isolated permission profile", retryable: false, effect: "none" });
    this.resolvedExecutablePath = executable;
    const workspaceAccess = canWrite ? "write" : "read";
    const profileArgs = permissionProfileArgs(dirname(executable), workspaceAccess, network, linkedWorktreeCommonDir(project.rootDir));
    await this.preflightSandbox(executable, project.rootDir, profileArgs, canWrite, environment.values, context);
    const args: string[] = ["exec", "--json", "--ignore-user-config", "--ignore-rules", ...connectedFeatureArgs(), ...profileArgs];
    if (capabilities.supportedAutomationFlags.includes("--ask-for-approval")) args.push("--ask-for-approval", "never");
    else args.push("--config", 'approval_policy="never"');
    if (capabilities.supportedAutomationFlags.includes("--color")) args.push("--color", "never");
    if (capabilities.supportedAutomationFlags.includes("--ephemeral")) args.push("--ephemeral");
    if (capabilities.supportedAutomationFlags.includes("--skip-git-repo-check")) args.push("--skip-git-repo-check");
    args.push(prompt);
    return {
      project,
      executable,
      prompt,
      args,
      environment,
      posture: capabilityPosture(network ? "granted" : "suppressed", sandbox, "suppressed"),
      effectClass: canWrite ? "workspace_write" : "read",
      capabilities,
    };
  }

  private async execute(agentRunId: AgentRunId, task: AgentTask, context: OperationContext, prepared: PreparedExecution, startedAt: string): Promise<AgentRun> {
    const maxOutputBytes = Math.min(this.maxOutputBytes, context.budgets.maxOutputBytes, context.budgets.maxReturnedOutputBytes);
    const parser = new CodexJsonlParser(maxOutputBytes);
    const transcriptLimit = Math.min(256 * 1024, context.budgets.maxArtifactBytes, context.budgets.maxRawOutputBytes);
    const transcript: string[] = [];
    let rawOutputBytes = 0;
    let stderrBytes = 0;
    let stderr = "";
    const processStarted = this.tracer.now();
    let child: AgentChildProcess;
    try { child = this.spawnProcess(prepared.executable, prepared.args, { cwd: prepared.project.rootDir, env: prepared.environment.values, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (cause) {
      const error = errorFor(cause, "AGENT_SPAWN_FAILED");
      return this.finishWithoutProcess(this.baseRun(agentRunId, task, context, "failed", "failed", error.effect, startedAt, this.tracer.now().toISOString(), "", error.message, this.emptyMetrics(byteLength(prepared.prompt), false), prepared.posture, prepared.environment.evidence, [], undefined, error), "failed", error);
    }
    const active: ActiveAgent = { process: child, runId: task.runId, cancelRequested: false, complete: Promise.resolve() };
    let completeResolve: (() => void) | undefined;
    active.complete = new Promise<void>((resolveComplete) => { completeResolve = resolveComplete; });
    this.active.set(agentRunId, active);
    let spawnError: Error | undefined;
    let closeCode: number | null = null;
    let closeSignal: string | null = null;
    let closeResolve: (() => void) | undefined;
    let closeReject: ((error: Error) => void) | undefined;
    const closed = new Promise<void>((resolveClose, rejectClose) => { closeResolve = resolveClose; closeReject = rejectClose; });
    child.stdout.on("data", (chunk) => {
      rawOutputBytes += typeof chunk === "string" ? byteLength(chunk) : chunk.byteLength;
      if (this.captureTranscript && byteLength(transcript.join("")) < transcriptLimit) transcript.push(bounded(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk), transcriptLimit - byteLength(transcript.join(""))));
      parser.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const value = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      stderrBytes += typeof chunk === "string" ? byteLength(chunk) : chunk.byteLength;
      if (stderr.length < 4_096) stderr = bounded(`${stderr}${value}`, 4_096);
      if (this.captureTranscript && byteLength(transcript.join("")) < transcriptLimit) transcript.push(bounded(value, transcriptLimit - byteLength(transcript.join(""))));
    });
    child.on("error", (error) => { spawnError = error; closeReject?.(error); });
    child.on("close", (code, signal) => { closeCode = code; closeSignal = signal; closeResolve?.(); });
    const abort = (): void => {
      active.cancelRequested = true;
      child.kill("SIGTERM");
      active.cancelTimer = setTimeout(() => { child.kill("SIGKILL"); }, this.cancelGraceMs);
    };
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (context.deadline !== undefined) {
      const remaining = Math.max(0, context.deadline - Date.now());
      deadlineTimer = setTimeout(abort, remaining);
    }
    if (context.signal.aborted) abort();
    else context.signal.addEventListener("abort", abort, { once: true });
    let parsed: ParsedCodexJsonl;
    try {
      await closed;
      parsed = parser.finish();
    } catch (cause) {
      parsed = parser.finish();
      spawnError = spawnError ?? (cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      context.signal.removeEventListener("abort", abort);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (active.cancelTimer !== undefined) clearTimeout(active.cancelTimer);
    }
    const durationMs = Math.max(0, this.tracer.now().getTime() - processStarted.getTime());
    let terminal = parsed.terminalState;
    if (active.cancelRequested || context.signal.aborted) terminal = "cancelled";
    else if (spawnError !== undefined) terminal = "failed";
    else if (closeSignal !== null) terminal = terminal === "completed" ? "contradictory" : "failed";
    else if (closeCode !== 0) terminal = terminal === "completed" ? "contradictory" : terminal === "contradictory" ? "contradictory" : terminal === "incomplete" ? "failed" : terminal;
    const status = statusForTerminal(terminal);
    const output = bounded(parsed.output, maxOutputBytes);
    const artifactRefs = this.captureTranscript && transcript.length > 0
      ? [this.artifacts.put(transcript.join(""), { ...(context.projectId === undefined ? {} : { projectId: context.projectId }), mediaType: "application/x-ndjson", origin: "codex.exec", sensitivity: this.transcriptSensitivity }).ref]
      : [];
    const artifactBytes = artifactRefs.reduce((total, ref) => total + (this.artifacts.metadata(ref)?.size ?? 0), 0);
    const metrics: AgentMetrics = {
      durationMs,
      inputBytes: byteLength(prepared.prompt),
      rawOutputBytes: rawOutputBytes + stderrBytes,
      returnedOutputBytes: byteLength(output),
      artifactBytes,
      commandCount: parsed.commandCount,
      toolCallCount: parsed.toolCallCount,
      retries: parsed.retries,
      cancellationRequested: active.cancelRequested,
      ...(closeCode === null ? {} : { exitCode: closeCode }),
      ...(closeSignal === null ? {} : { signal: closeSignal }),
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
    };
    const error = spawnError === undefined ? terminalError(terminal, closeCode, closeSignal) : createRuntimeError({ code: "AGENT_SPAWN_FAILED", message: spawnError.message, retryable: false, effect: "none" });
    const effectState: EffectState = status === "completed" ? (prepared.effectClass === "workspace_write" ? "applied" : "none") : status === "failed" && closeCode === null ? "none" : "unknown";
    const result: AgentRun = { ...this.baseRun(agentRunId, task, context, status, terminal, effectState, startedAt, this.tracer.now().toISOString(), output, status === "completed" ? "Codex completed" : (error?.message ?? (stderr || "Codex execution did not complete")), metrics, prepared.posture, prepared.environment.evidence, artifactRefs, parsed.threadId, error, parsed.turnId, parsed.unknownEventTypes), capabilitySnapshot: prepared.capabilities };
    this.persistAgent(result, status);
    const eventType = status === "completed" ? "agent.completed" : status === "cancelled" ? "agent.cancelled" : status === "unknown" ? "agent.failed" : "agent.failed";
    this.emitAgent(eventType, result, status, prepared.effectClass, result.summary, error);
    if (this.tasks !== undefined) {
      const current = this.tasks.get(task.taskId);
      if (current?.status === "running") {
        if (status === "completed") this.tasks.complete(task.taskId, { reason: "Codex completed" }, context);
        else if (status === "cancelled") this.tasks.cancel(task.taskId, { reason: "Codex cancelled" }, context);
        else if (status === "unknown") this.tasks.markUnknown(task.taskId, { reason: error?.code ?? "Codex terminal state unknown" }, context);
        else this.tasks.fail(task.taskId, { reason: error?.code ?? "Codex failed" }, context);
      }
    }
    this.active.delete(agentRunId);
    completeResolve?.();
    return result;
  }

  private baseRun(
    agentRunId: AgentRunId,
    task: AgentTask,
    context: OperationContext,
    status: AgentRun["status"],
    terminalState: AgentRun["terminalState"],
    effectState: EffectState,
    startedAt: string,
    completedAt: string,
    output: string,
    summary: string,
    metrics: AgentMetrics,
    posture: CapabilityPosture,
    environment: EnvironmentEvidence,
    artifactRefs: readonly import("../core/ids.ts").ArtifactRef[],
    providerThreadId: string | undefined,
    error: RuntimeError | undefined,
    providerTurnId?: string,
    unknownEventTypes: readonly string[] = [],
  ): AgentRun {
    return {
      agentRunId,
      traceId: context.traceId,
      runId: task.runId,
      taskId: task.taskId,
      projectId: task.projectId,
      executor: EXECUTOR,
      provider: PROVIDER,
      status,
      terminalState,
      effectState,
      startedAt,
      completedAt,
      ...(providerThreadId === undefined ? {} : { providerThreadId }),
      ...(providerTurnId === undefined ? {} : { providerTurnId }),
      output,
      summary: bounded(summary, 1_024),
      metrics,
      artifactRefs: [...artifactRefs],
      capabilityPosture: posture,
      environment,
      unknownEventTypes: [...unknownEventTypes],
      ...(error === undefined ? {} : { error }),
    };
  }

  private emptyMetrics(inputBytes: number, cancellationRequested: boolean): AgentMetrics {
    return { durationMs: 0, inputBytes, rawOutputBytes: 0, returnedOutputBytes: 0, artifactBytes: 0, commandCount: 0, toolCallCount: 0, retries: 0, cancellationRequested };
  }

  private finishWithoutProcess(run: AgentRun, terminal: AgentRun["terminalState"], error: RuntimeError): AgentRun {
    const status = statusForTerminal(terminal);
    const finished = { ...run, status, terminalState: terminal, effectState: error.effect, completedAt: this.tracer.now().toISOString(), summary: bounded(error.message, 1_024), error };
    this.persistAgent(finished, status);
    this.emitAgent(status === "cancelled" ? "agent.cancelled" : status === "unknown" ? "agent.failed" : "agent.failed", finished, status, "read", finished.summary, error);
    return finished;
  }

  private persistAgent(run: AgentRun, status: string): void {
    this.state?.saveEntity({
      kind: "agent_runs",
      id: run.agentRunId,
      projectId: run.projectId,
      runId: run.runId,
      taskId: run.taskId,
      status,
      createdAt: run.startedAt,
      updatedAt: run.completedAt,
      data: {
        agentRunId: run.agentRunId,
        traceId: run.traceId,
        taskId: run.taskId,
        runId: run.runId,
        projectId: run.projectId,
        executor: run.executor,
        provider: run.provider,
        terminalState: run.terminalState,
        effectState: run.effectState,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        ...(run.providerThreadId === undefined ? {} : { providerThreadId: run.providerThreadId }),
        ...(run.providerTurnId === undefined ? {} : { providerTurnId: run.providerTurnId }),
        summary: run.summary,
        metrics: run.metrics,
        artifactRefs: run.artifactRefs,
        capabilityPosture: run.capabilityPosture,
        ...(run.capabilitySnapshot === undefined ? {} : { capabilitySnapshot: run.capabilitySnapshot }),
        credentialBoundary: run.environment,
        unknownEventTypes: run.unknownEventTypes,
        ...(run.error === undefined ? {} : { error: { code: run.error.code, message: run.error.message, effect: run.error.effect, retryable: run.error.retryable } }),
      },
    });
  }

  private emitAgent(type: Extract<RuntimeEvent["type"], `agent.${string}`>, run: AgentRun, status: RuntimeStatus, effectClass: EffectClass, summary: string, error?: RuntimeError): void {
    const event = this.tracer.emit({
      traceId: run.traceId,
      runId: run.runId,
      taskId: run.taskId,
      projectId: run.projectId,
      spanId: createSpanId(),
      type,
      actor: DEFAULT_AGENT_ACTOR,
      executor: EXECUTOR,
      provider: PROVIDER,
      status,
      summary,
      effectClass,
      effectState: run.effectState,
      measurements: asMeasurements(run.metrics),
      artifactRefs: run.artifactRefs,
      ...(error === undefined ? {} : { errorCode: error.code }),
      metadata: {
        agentRunId: run.agentRunId,
        terminalState: run.terminalState,
        unknownEventTypes: run.unknownEventTypes,
        capabilityPosture: run.capabilityPosture,
        credentialBoundary: run.environment,
        ...(run.capabilitySnapshot === undefined ? {} : { capabilitySnapshot: run.capabilitySnapshot }),
        ...(run.providerThreadId === undefined ? {} : { providerThreadId: run.providerThreadId }),
        ...(run.providerTurnId === undefined ? {} : { providerTurnId: run.providerTurnId }),
      },
    });
    if (this.state !== undefined && this.state.getEvent(event.eventId) === undefined) this.state.append(event);
  }

  private async preflightSandbox(
    executable: string,
    workspace: string,
    profileArgs: readonly string[],
    canWrite: boolean,
    environment: Readonly<Record<string, string | undefined>>,
    context: OperationContext,
  ): Promise<void> {
    const base = ["sandbox", ...profileArgs, "-P", "aer_worker", "-C", workspace, "--"];
    const commands: readonly (readonly string[])[] = [
      ["/usr/bin/true"],
      ...(canWrite ? [["/bin/sh", "-ceu", 'umask 077; probe="$1"; set -C; : > "$probe"; rm -f -- "$probe"', "aer-workspace-write-probe", `.aer-write-probe-${createAgentRunId()}`] as const] : []),
    ];
    for (const command of commands) {
      const result = await this.probe(executable, [...base, ...command], environment, context);
      if (result.code !== 0) throw createRuntimeError({ code: "AGENT_SANDBOX_PREFLIGHT_FAILED", message: "Codex isolated permission profile failed before model execution", retryable: false, effect: "none", details: { exitCode: result.code, signal: result.signal } });
    }
  }

  private async probe(executable: string, args: readonly string[], environment: Readonly<Record<string, string | undefined>>, context?: OperationContext): Promise<ProbeResult> {
    const child = this.spawnProcess(executable, args, { cwd: tmpdir(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const configuredDeadline = context?.deadline;
    const deadline = configuredDeadline === undefined || !Number.isFinite(configuredDeadline)
      ? Date.now() + DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS
      : configuredDeadline;
    return await new Promise<ProbeResult>((resolveProbe, rejectProbe) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        context?.signal.removeEventListener("abort", abort);
      };
      const rejectBounded = (message: string): void => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGTERM"); } catch { /* best effort */ }
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* best effort */ } }, 25);
        cleanup();
        rejectProbe(createRuntimeError({ code: "AGENT_CAPABILITY_PROBE_TIMEOUT", message, retryable: true, effect: "none" }));
      };
      const abort = (): void => rejectBounded("Codex capability probing was cancelled or exceeded its runtime budget");
      child.stdout.on("data", (chunk) => { stdout = bounded(`${stdout}${typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)}`, 32 * 1024); });
      // Drain stderr so a noisy executable cannot block before the bounded
      // probe timer fires. Its contents are deliberately not model-facing.
      child.stderr.on("data", () => undefined);
      child.on("error", (error) => { if (!settled) { settled = true; cleanup(); rejectProbe(error); } });
      child.on("close", (code, signal) => { if (!settled) { settled = true; cleanup(); resolveProbe({ code, signal, stdout }); } });
      if (context?.signal.aborted) abort();
      else {
        context?.signal.addEventListener("abort", abort, { once: true });
        const remaining = Math.max(0, deadline - Date.now());
        timer = setTimeout(() => rejectBounded("Codex capability probing exceeded its bounded deadline"), remaining);
      }
    });
  }
}

export { CodexAgentExecutor as CodexExecutor };
