import type { Capabilities, Capability } from "../core/capabilities.ts";
import type { EffectState } from "../core/effects.ts";
import type { ArtifactRef, ProjectId, RunId, TaskId, TraceId } from "../core/ids.ts";
import type { OperationContext, Actor } from "../core/context.ts";
import type { RuntimeError, RuntimeStatus } from "../core/result.ts";

/** A provider-neutral identifier for an AER-owned delegated execution. */
export type AgentRunId = string & { readonly __brand: "AgentRunId" };

export function createAgentRunId(): AgentRunId {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `agent_run_${uuid}` as AgentRunId;
}

export type AgentTerminalState = "completed" | "failed" | "cancelled" | "incomplete" | "contradictory";

/** Input owned by AER. Provider thread/session data is deliberately absent. */
export interface AgentTask {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly title?: string;
  readonly goal?: string;
  readonly prompt?: string;
  /** Alias for transports that call the model-facing task input `input`. */
  readonly input?: string;
  /** A caller supplied workspace is never trusted as execution authority. */
  readonly workspace?: string;
}

export type AgentCapability = Capability | "bidirectional" | "app_server";

export interface CapabilityPosture {
  readonly userConfig: "ignored";
  readonly execPolicy: "ignored";
  readonly sandbox: "read-only" | "workspace-write";
  readonly approval: "never";
  readonly network: "suppressed" | "granted" | "unavailable";
  readonly apps: "suppressed" | "granted" | "unavailable";
  readonly plugins: "suppressed" | "granted" | "unavailable";
  readonly hooks: "suppressed" | "granted" | "unavailable";
  readonly browser: "suppressed" | "granted" | "unavailable";
  readonly computerUse: "suppressed" | "granted" | "unavailable";
  readonly remotePlugins: "suppressed" | "granted" | "unavailable";
  readonly multiAgent: "suppressed" | "granted" | "unavailable";
}

export interface AgentCapabilities {
  readonly executor: string;
  readonly provider: string;
  readonly version?: string;
  readonly installedVersion?: string;
  readonly detectedAt: string;
  readonly compatible: boolean;
  /** Core capability values are what consumers should branch on. */
  readonly capabilities: Capabilities;
  readonly supportedCapabilities: readonly AgentCapability[];
  readonly appServer: "available" | "unavailable" | "unsupported";
  readonly requiredIsolation: readonly string[];
  readonly supportedIsolation: readonly string[];
  readonly supportedAutomationFlags: readonly string[];
  readonly incompatibilities: readonly string[];
  readonly capabilityPosture: CapabilityPosture;
}

export interface AgentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
}

export interface AgentMetrics {
  readonly durationMs: number;
  readonly inputBytes: number;
  readonly rawOutputBytes: number;
  readonly returnedOutputBytes: number;
  readonly artifactBytes: number;
  readonly commandCount: number;
  readonly toolCallCount: number;
  readonly retries: number;
  readonly cancellationRequested: boolean;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly usage?: AgentUsage;
}

export interface CredentialEvidence {
  readonly key: string;
  readonly class: string;
}

export interface EnvironmentEvidence {
  readonly baselineKeys: readonly string[];
  readonly granted: readonly CredentialEvidence[];
  readonly withheld: readonly CredentialEvidence[];
  readonly valueLogging: "disabled";
}

export interface AgentRun {
  readonly agentRunId: AgentRunId;
  readonly traceId: TraceId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly executor: string;
  readonly provider: string;
  readonly status: Extract<RuntimeStatus, "completed" | "failed" | "cancelled" | "unknown">;
  readonly terminalState: AgentTerminalState;
  readonly effectState: EffectState;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly providerThreadId?: string;
  readonly providerTurnId?: string;
  /** Compact model-facing output; full transcript capture is opt-in. */
  readonly output: string;
  readonly summary: string;
  readonly metrics: AgentMetrics;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly capabilityPosture: CapabilityPosture;
  readonly environment: EnvironmentEvidence;
  readonly capabilitySnapshot?: AgentCapabilities;
  readonly unknownEventTypes: readonly string[];
  readonly error?: RuntimeError;
}

export interface AgentExecutor {
  capabilities(): Promise<AgentCapabilities>;
  run(task: AgentTask, context: OperationContext): Promise<AgentRun>;
  cancel(agentRunId: AgentRunId | string): Promise<void>;
}

export interface AgentChildStream {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
}

/** Narrow process seam used by fixtures and by the real Codex child process. */
export interface AgentChildProcess {
  readonly pid?: number;
  readonly stdout: AgentChildStream;
  readonly stderr: AgentChildStream;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): boolean;
}

export interface AgentSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type AgentSpawn = (executable: string, args: readonly string[], options: AgentSpawnOptions) => AgentChildProcess;

export interface CodexEnvironmentOptions {
  /** Explicit non-secret values/variables needed by the provider or fixture. */
  readonly variables?: Readonly<Record<string, string | undefined>>;
  /** Alias for variables used by callers that distinguish safe values from credentials. */
  readonly safeVariables?: Readonly<Record<string, string | undefined>>;
  /** Names explicitly allowed to pass through from the parent environment. */
  readonly passThroughKeys?: readonly string[];
  readonly allowedEnvironmentKeys?: readonly string[];
  /** Provider authentication/config variables, recorded by name and class only. */
  readonly providerKeys?: readonly string[];
  readonly providerRequiredKeys?: readonly string[];
  /** Optional isolated provider home. It is never inferred from an arbitrary caller path. */
  readonly codexHome?: string;
  readonly providerHome?: string;
  readonly credentialClassifiers?: readonly CredentialClassifier[];
}

export interface CredentialClassifier {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface CodexExecutorOptions {
  readonly executable?: string;
  readonly registry?: import("../project/registry.ts").ProjectRegistry;
  readonly state?: import("../state/store.ts").StateStore;
  readonly artifacts?: import("../artifacts/store.ts").ArtifactStore;
  readonly tracer?: import("../observability/tracer.ts").Tracer;
  readonly spawn?: AgentSpawn;
  readonly environment?: CodexEnvironmentOptions;
  readonly maxOutputBytes?: number;
  readonly maxInputBytes?: number;
  readonly cancelGraceMs?: number;
  /** Capture a bounded transcript artifact. Disabled by default. */
  readonly captureTranscript?: boolean;
  readonly transcriptSensitivity?: import("../observability/redaction.ts").Sensitivity;
  /** Allows network access only when the AER effect policy also allows it. */
  readonly grantNetwork?: boolean;
  /** Optional task state owner for callers that want task transitions coordinated. */
  readonly tasks?: import("../tasks/index.ts").TaskManager;
}

export interface ParsedCodexEvent {
  readonly type: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly line: number;
}

export interface ParsedCodexJsonl {
  readonly events: readonly ParsedCodexEvent[];
  readonly unknownEventTypes: readonly string[];
  readonly malformedLines: number;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly output: string;
  readonly usage?: AgentUsage;
  readonly commandCount: number;
  readonly toolCallCount: number;
  readonly retries: number;
  readonly terminalState: AgentTerminalState;
  readonly terminalTypes: readonly string[];
}

export interface CodexCapabilityProbe {
  readonly installedVersion?: string;
  readonly supportedAutomationFlags: readonly string[];
  readonly appServer: "available" | "unavailable" | "unsupported";
}

export const DEFAULT_AGENT_ACTOR: Actor = "provider";
