import type { OperationContext } from "../core/context.ts";
import type { EffectClass } from "../core/effects.ts";
import type { RuntimeResult } from "../core/result.ts";
import type { ExecutableCommand, ShellRunInput } from "../direct/types.ts";

export type SandboxAvailability = "unavailable" | "available_requires_setup" | "ready";
export type IsolationType = "host" | "container" | "microvm" | "unknown";
export type WorkspaceMode = "host" | "private_clone" | "private_copy" | "ephemeral" | "unknown";
export type PersistenceMode = "ephemeral" | "filesystem" | "checkpointed" | "unknown";
export type NetworkControl = "unsupported" | "allow_deny" | "policy_only" | "unknown";
export type CredentialSupport = "unsupported" | "named_grants" | "proxy" | "unknown";

export interface SandboxFeatureCapabilities {
  readonly pauseResume: boolean;
  readonly checkpoint: boolean;
  readonly snapshot: boolean;
  readonly fork: boolean;
  readonly clone: boolean;
  readonly resourceLimits: boolean;
}

export interface SandboxCapabilities {
  readonly provider: string;
  readonly state: SandboxAvailability;
  readonly setupRequired: boolean;
  readonly isolationType: IsolationType;
  /** Alias for consumers that use the shorter architecture vocabulary. */
  readonly isolation: IsolationType;
  readonly workspaceMode: WorkspaceMode;
  readonly workspaceModes: readonly WorkspaceMode[];
  readonly persistence: PersistenceMode;
  readonly pauseResume: boolean;
  readonly checkpoint: boolean;
  readonly snapshot: boolean;
  readonly fork: boolean;
  readonly clone: boolean;
  readonly networkControl: NetworkControl;
  readonly resourceLimits: boolean;
  readonly credentialSupport: CredentialSupport;
  readonly credentials: CredentialSupport;
  readonly secrets: CredentialSupport;
  readonly features: SandboxFeatureCapabilities;
  readonly setupAction?: string;
  readonly reason?: string;
}

export interface SandboxExecutionRequest {
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnvironment?: boolean;
  readonly effectClass?: EffectClass;
  readonly workspaceMode?: WorkspaceMode;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface SandboxExecutionResult {
  readonly provider: string;
  readonly isolationType: IsolationType;
  readonly workspaceMode: WorkspaceMode;
  readonly status: "completed" | "failed" | "cancelled" | "unknown";
  readonly effectState: "none" | "unknown" | "applied";
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly rawOutputBytes: number;
  readonly returnedOutputBytes: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface SandboxProvider {
  readonly name: string;
  capabilities(): SandboxCapabilities | Promise<SandboxCapabilities>;
  execute(request: SandboxExecutionRequest, context: OperationContext): Promise<RuntimeResult<SandboxExecutionResult>>;
}

export type ExecutionEnvironmentCapabilities = SandboxCapabilities;
export type ExecutionEnvironmentProvider = SandboxProvider;

export interface SbxCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut?: boolean;
}

export interface SbxCli {
  run(args: readonly string[], options?: { readonly timeoutMs?: number }): Promise<SbxCliResult> | SbxCliResult;
}

export interface DockerSandboxProviderOptions {
  readonly cli?: SbxCli;
  readonly tracer?: import("../observability/tracer.ts").Tracer;
  readonly setupAction?: string;
  readonly maxOutputBytes?: number;
  readonly detectionTimeoutMs?: number;
}
