import type { ProjectId, RunId, TaskId, ArtifactRef, TraceId } from "../core/ids.ts";
import type { RuntimeStatus } from "../core/result.ts";
import type { ProjectConfig } from "./config.ts";

export interface ProjectIdentity {
  readonly projectId: ProjectId;
  /** Alias useful to transports that call every identifier an id. */
  readonly id: ProjectId;
  readonly name: string;
  readonly rootDir: string;
  readonly root: string;
  readonly configPath: string;
  readonly goal?: string;
  readonly config: ProjectConfig;
}

/**
 * Bounded identity exposed by live project context operations. Repository
 * configuration is intentionally kept in the registry and is not copied into
 * resume or inspect payloads.
 */
export interface ProjectIdentityView {
  readonly projectId: ProjectId;
  readonly id: ProjectId;
  readonly name: string;
  readonly rootDir: string;
  readonly root: string;
  readonly configPath: string;
  readonly goal?: string;
}

export type ProjectRef = ProjectIdentity | ProjectIdentityView | ProjectId | string;

export interface GitDiffSummary {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly untrackedFiles: number;
  readonly summary: string;
}

export interface GitSnapshot {
  readonly available: boolean;
  /** The configured project root, even when it is not a Git work tree. */
  readonly root: string;
  readonly gitRoot?: string;
  readonly branch?: string;
  readonly head?: string;
  readonly dirty: boolean;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly upstreamDivergence: {
    readonly ahead: number;
    readonly behind: number;
  };
  readonly diff: GitDiffSummary;
  readonly diffSummary: GitDiffSummary;
  readonly error?: string;
}

export interface TaskSummary {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly title: string;
  readonly status: RuntimeStatus;
  readonly updatedAt: string;
  readonly reason?: string;
}

export interface RunSummary {
  readonly runId: RunId;
  readonly status: RuntimeStatus;
  readonly updatedAt: string;
  readonly summary?: string;
}

export interface VerificationSummary {
  readonly verificationId: string;
  readonly status: RuntimeStatus | "passed" | "failed";
  readonly passed?: boolean;
  readonly updatedAt: string;
  readonly summary?: string;
  readonly artifactRefs: readonly ArtifactRef[];
}

export interface ProjectInspect {
  readonly project: ProjectIdentityView;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly root: string;
  readonly goal?: string;
  readonly git: GitSnapshot;
  readonly activeTasks: readonly TaskSummary[];
  readonly activeProcesses: readonly Readonly<Record<string, unknown>>[];
  readonly latestVerification?: VerificationSummary;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface ResumeEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly status?: RuntimeStatus;
  readonly summary?: string;
  readonly taskId?: TaskId;
  readonly runId?: RunId;
  readonly artifactRefs: readonly ArtifactRef[];
}

export interface ResumeBlocker {
  readonly source: string;
  readonly message: string;
  readonly status?: string;
}

export interface ProjectResume {
  readonly project: ProjectIdentityView;
  readonly projectId: ProjectId;
  readonly identity: {
    readonly name: string;
    readonly root: string;
    readonly goal?: string;
  };
  readonly activeDecisions: readonly Readonly<Record<string, unknown>>[];
  readonly activeTasks: readonly TaskSummary[];
  readonly activeRuns: readonly RunSummary[];
  readonly recentEvents: readonly ResumeEvent[];
  readonly git: GitSnapshot;
  readonly lastAgent?: Readonly<Record<string, unknown>>;
  readonly lastVerification?: VerificationSummary;
  readonly blockers: readonly ResumeBlocker[];
  readonly unknownEffects: readonly ResumeBlocker[];
  readonly artifactRefs: readonly ArtifactRef[];
}

export interface ProjectRegistrationInput {
  readonly rootDir: string;
  readonly projectId?: ProjectId;
  readonly id?: ProjectId;
  readonly name?: string;
  readonly goal?: string;
  readonly verify?: ProjectConfig["verify"];
  readonly config?: Partial<ProjectConfig>;
  /** Defaults to true when a project has no config file. */
  readonly writeConfig?: boolean;
}

export interface ProjectOperationInput {
  readonly project: ProjectRef;
}

export interface ProjectResumeOptions {
  readonly eventLimit?: number;
  readonly itemLimit?: number;
}

export interface ProjectRuntimeOptions {
  readonly state?: import("../state/store.ts").StateStore;
  readonly tracer?: import("../observability/tracer.ts").Tracer;
  readonly artifacts?: import("../artifacts/store.ts").ArtifactStore;
  readonly direct?: import("../direct/executor.ts").DirectExecutor;
  readonly registry?: import("./registry.ts").ProjectRegistry;
}

export interface ProjectRecordData {
  readonly traceId?: TraceId;
  readonly config: ProjectConfig;
  readonly rootDir: string;
  readonly name: string;
  readonly goal?: string;
}
