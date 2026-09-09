import type { OperationContext } from "../core/context.ts";
import type { EffectState } from "../core/effects.ts";
import type { ArtifactRef } from "../core/ids.ts";
import type { RuntimeResult } from "../core/result.ts";
import type { ExecutableCommand, ShellRunInput } from "../direct/types.ts";

export type GitHubProviderRoute = "gh-json" | "gh-api" | "raw-gh" | "unavailable";

/** The deliberately small command boundary used by the GitHub provider. */
export interface GitHubCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  /** Optional transport metadata exposed by richer command runners. */
  readonly httpStatus?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawOutputBytes?: number;
  readonly returnedOutputBytes?: number;
  readonly artifactBytes?: number;
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly truncated?: boolean;
}

/**
 * Injectable for deterministic provider tests. The production adapter below
 * delegates these two methods to DirectExecutor, so raw fallback remains the
 * existing shell.run escape hatch rather than a second shell implementation.
 */
export interface GitHubCommandRunner {
  runExecutable(command: ExecutableCommand, context: OperationContext): Promise<GitHubCommandResult>;
  runShell(input: ShellRunInput, context: OperationContext): Promise<GitHubCommandResult>;
}

export interface GitHubCapabilityInput {
  readonly cwd?: string;
}

export interface GitHubCapabilities {
  readonly available: boolean;
  readonly ghAvailable: boolean;
  readonly authenticated: boolean;
  readonly account?: string;
  readonly repository?: GitHubRepository;
  readonly currentRepository?: GitHubRepository;
  readonly version?: string;
  readonly structuredJson: boolean;
  readonly api: boolean;
  readonly rawGh: boolean;
  readonly routes: readonly GitHubProviderRoute[];
  readonly error?: string;
}

export interface GitHubRepository {
  readonly name: string;
  readonly owner: string;
  readonly nameWithOwner: string;
  readonly url?: string;
  readonly defaultBranch?: string;
}

export interface GitHubCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string;
  readonly url?: string;
}

export interface GitHubChecksSummary {
  readonly state: "pending" | "success" | "failure" | "neutral";
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /** False means the provider could not prove that all check sources were read. */
  readonly complete?: boolean;
}

export interface GitHubReview {
  readonly author?: string;
  readonly state: string;
  readonly submittedAt?: string;
}

export interface GitHubReviewsSummary {
  readonly decision?: string;
  readonly approved: number;
  readonly changesRequested: number;
  readonly pending: number;
  /** False means the provider could not prove that the review state is current. */
  readonly complete?: boolean;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title?: string;
  readonly state?: string;
  readonly url?: string;
  readonly isDraft?: boolean;
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly headRepositoryOwner?: string;
  readonly headRepositoryNameWithOwner?: string;
  readonly baseRefName?: string;
  readonly baseRefOid?: string;
  readonly checks: readonly GitHubCheck[];
  readonly checksSummary: GitHubChecksSummary;
  readonly reviews: readonly GitHubReview[];
  readonly reviewsSummary: GitHubReviewsSummary;
}

export interface GitHubIssue {
  readonly number: number;
  readonly title?: string;
  readonly state?: string;
  readonly url?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface GitHubIssueDependencies {
  readonly issue: number;
  /** Dependency links whose Issues are not known to be closed. */
  readonly blockedBy: readonly number[];
  readonly blocking: readonly number[];
  /** Present when one or more native dependency reads are incomplete or failed. */
  readonly state?: "unknown";
}

export interface GitHubWorkItem extends GitHubIssue {
  readonly status: "ready" | "blocked" | "in_progress" | "completed" | "unknown";
  readonly blockedBy: readonly number[];
}

export interface GitHubWorkSnapshot {
  readonly items: readonly GitHubWorkItem[];
  readonly dependencies: readonly GitHubIssueDependencies[];
  readonly ready: readonly number[];
  readonly blocked: readonly number[];
  readonly inProgress: readonly number[];
  readonly completed: readonly number[];
}

export interface GitHubWorkInput {
  readonly cwd?: string;
  readonly issueNumbers: readonly number[];
}

export interface GitHubSnapshotInput {
  readonly cwd?: string;
  readonly rootDir?: string;
  readonly issueNumber?: number;
  readonly issueNumbers?: readonly number[];
  readonly includeWork?: boolean;
}

export interface GitHubSnapshot {
  readonly available: boolean;
  readonly repository?: GitHubRepository;
  readonly currentBranch?: string;
  readonly currentHead?: string;
  readonly currentPullRequest?: GitHubPullRequest;
  readonly checks?: GitHubChecksSummary;
  readonly reviews?: GitHubReviewsSummary;
  readonly issue?: GitHubIssue;
  readonly dependencies?: GitHubIssueDependencies;
  readonly work?: GitHubWorkSnapshot;
  readonly route: GitHubProviderRoute;
  readonly error?: string;
}

export interface GitHubWaitInput {
  readonly cwd?: string;
  readonly pullRequest?: number | string;
  readonly condition?: "checks_terminal" | "checks_passed";
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly maxPolls?: number;
}

export interface GitHubWaitResult {
  readonly pullRequest: number;
  readonly terminal: boolean;
  readonly passed: boolean;
  readonly checks: readonly GitHubCheck[];
  readonly checksSummary: GitHubChecksSummary;
  readonly pollCountInternal: number;
  readonly pollCountModel: 0;
  readonly timedOut: boolean;
}

export interface GitHubPublishInput {
  readonly cwd?: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly title: string;
  readonly body?: string;
  readonly base?: string;
}

export interface GitHubEffectReceipt {
  readonly operation: "github.publish";
  readonly repository: GitHubRepository;
  readonly branch: string;
  readonly localHead: string;
  readonly remoteHead: string;
  readonly pushed: boolean;
  readonly pullRequest: GitHubPullRequest;
  readonly created: boolean;
  readonly reused: boolean;
  readonly reconciled: boolean;
  readonly effectState: EffectState;
}

export interface GitHubProviderOptions {
  readonly direct?: import("../direct/executor.ts").DirectExecutor;
  readonly tracer?: import("../observability/tracer.ts").Tracer;
  readonly runner?: GitHubCommandRunner;
  /** Injectable wall-clock source for deterministic wait/rate-limit tests. */
  readonly clock?: () => number | Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly maxOutputBytes?: number;
}

export type GitHubOperationResult<T> = RuntimeResult<T>;
