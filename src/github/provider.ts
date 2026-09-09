import { createOperationContext, type OperationContext } from "../core/context.ts";
import { isEffectAllowed, permissiveEffectPolicy, requiresApproval, type EffectClass, type EffectState } from "../core/effects.ts";
import {
  createOperationMeta,
  createRuntimeError,
  isRuntimeError,
  runtimeFailure,
  runtimeSuccess,
  type OperationMeasurements,
  type RuntimeError,
  type RuntimeResult,
} from "../core/result.ts";
import { createRunId, createTraceId, type ArtifactRef } from "../core/ids.ts";
import { DirectExecutor } from "../direct/index.ts";
import type { ExecutableCommand, ShellRunInput } from "../direct/types.ts";
import { Tracer, type OperationSpan } from "../observability/index.ts";
import type {
  GitHubCapabilityInput,
  GitHubCapabilities,
  GitHubCheck,
  GitHubChecksSummary,
  GitHubCommandResult,
  GitHubCommandRunner,
  GitHubEffectReceipt,
  GitHubIssue,
  GitHubIssueDependencies,
  GitHubOperationResult,
  GitHubProviderOptions,
  GitHubProviderRoute,
  GitHubPullRequest,
  GitHubPublishInput,
  GitHubRepository,
  GitHubReview,
  GitHubReviewsSummary,
  GitHubSnapshot,
  GitHubSnapshotInput,
  GitHubWaitInput,
  GitHubWaitResult,
  GitHubWorkItem,
  GitHubWorkInput,
  GitHubWorkSnapshot,
} from "./types.ts";

const GH_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_WAIT_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_WAIT_MAX_POLLS = 120;
const PR_JSON_FIELDS = [
  "number", "title", "state", "url", "isDraft", "headRefName", "headRefOid",
  "baseRefName", "baseRefOid", "statusCheckRollup", "reviewDecision", "reviews",
].join(",");
const PR_LOOKUP_JSON_FIELDS = `${PR_JSON_FIELDS},headRepositoryOwner,headRepository`;
const REPO_JSON_FIELDS = "name,nameWithOwner,url,defaultBranchRef,owner";
const ISSUE_JSON_FIELDS = "number,title,state,url,labels,assignees";

type JsonObject = Record<string, unknown>;

interface ProviderWorkResult<T> {
  readonly data: T;
  readonly effectState?: EffectState;
  readonly summary?: string;
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly truncated?: boolean;
}

interface Attempt<T> {
  readonly value: T;
  readonly route: GitHubProviderRoute;
}

interface CreatePullRequestResult {
  readonly created: boolean;
  readonly pullRequest?: GitHubPullRequest;
  readonly effectState?: EffectState;
}

interface PullRequestLookupOptions {
  /**
   * After an effectful create attempt, a structured empty list is not enough
   * to conclude absence: the provider must try the lower-priority fresh API
   * and raw reads before reporting an ambiguous effect.
   */
  readonly reconcileAfterEmpty?: boolean;
}

class ProviderMetrics {
  internalCalls = 0;
  retries = 0;
  pollCountInternal = 0;
  readonly pollCountModel = 0;
  inputBytes = 0;
  rawOutputBytes = 0;
  returnedOutputBytes = 0;
  artifactBytes = 0;
  readonly artifactRefs: ArtifactRef[] = [];
  truncated = false;

  call(input: unknown): void {
    this.internalCalls += 1;
    this.inputBytes += byteLength(JSON.stringify(input));
  }

  observe(result: GitHubCommandResult): void {
    this.rawOutputBytes += result.rawOutputBytes ?? byteLength(`${result.stdout}${result.stderr}`);
    this.returnedOutputBytes += result.returnedOutputBytes ?? byteLength(`${result.stdout}${result.stderr}`);
    this.artifactBytes += result.artifactBytes ?? 0;
    this.artifactRefs.push(...(result.artifactRefs ?? []));
    this.truncated ||= result.truncated === true;
  }

  setReturnedOutputBytes(value: number): void {
    this.returnedOutputBytes = value;
  }

  snapshot(): Partial<OperationMeasurements> {
    return {
      internalCalls: this.internalCalls,
      retries: this.retries,
      pollCountInternal: this.pollCountInternal,
      pollCountModel: this.pollCountModel,
      inputBytes: this.inputBytes,
      rawOutputBytes: this.rawOutputBytes,
      returnedOutputBytes: this.returnedOutputBytes,
      artifactBytes: this.artifactBytes,
    };
  }
}

class DirectGitHubCommandRunner implements GitHubCommandRunner {
  private readonly direct: DirectExecutor;
  private readonly maxOutputBytes: number;

  constructor(direct: DirectExecutor, maxOutputBytes: number) {
    this.direct = direct;
    this.maxOutputBytes = maxOutputBytes;
  }

  async runExecutable(command: ExecutableCommand, context: OperationContext): Promise<GitHubCommandResult> {
    const result = await this.direct.runExecutable({
      ...command,
      maxOutputBytes: command.maxOutputBytes ?? this.maxOutputBytes,
    }, internalContext(context), { instrument: false });
    if (!result.ok) throw result.error;
    return processResult(result.data);
  }

  async runShell(input: ShellRunInput, context: OperationContext): Promise<GitHubCommandResult> {
    const result = await this.direct.runShell({
      ...input,
      maxOutputBytes: input.maxOutputBytes ?? this.maxOutputBytes,
    }, internalContext(context), { instrument: false });
    if (!result.ok) throw result.error;
    return processResult(result.data);
  }
}

function processResult(result: { readonly stdout: string; readonly stderr: string; readonly exitCode?: number; readonly rawOutputBytes: number; readonly returnedOutputBytes: number; readonly artifactBytes: number; readonly artifactRefs: readonly ArtifactRef[]; readonly truncated: boolean }): GitHubCommandResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    rawOutputBytes: result.rawOutputBytes,
    returnedOutputBytes: result.returnedOutputBytes,
    artifactBytes: result.artifactBytes,
    artifactRefs: result.artifactRefs,
    truncated: result.truncated,
  };
}

function internalContext(context: OperationContext): OperationContext {
  // DirectExecutor's universal raw primitive is intentionally classified as a
  // destructive effect. The semantic provider has already applied its own
  // read/network/remote policy, so internal provider plumbing must not require
  // the caller to grant shell permissions separately.
  return createOperationContext({
    ...context,
    actor: "provider",
    effectPolicy: permissiveEffectPolicy(),
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nested(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter((item): item is string => item !== undefined);
}

function parseJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function errorFor(cause: unknown, code: string, effect: EffectState = "none"): RuntimeError {
  if (isRuntimeError(cause)) return cause;
  return createRuntimeError({
    code,
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
    effect,
  });
}

function errorWithEffect(cause: unknown, code: string, effect: EffectState): RuntimeError {
  const error = errorFor(cause, code, effect);
  if (error.effect === effect) return error;
  return createRuntimeError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    effect,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

function repositoryPath(repository: GitHubRepository): string {
  return repository.nameWithOwner;
}

function parseRepository(value: unknown): GitHubRepository | undefined {
  if (!isObject(value)) return undefined;
  const ownerName = stringValue(nested(value.owner, "login")) ?? stringValue(nested(value.owner, "name"));
  const nameWithOwner = stringValue(value.nameWithOwner) ??
    stringValue(value.full_name) ??
    (ownerName !== undefined && stringValue(value.name) !== undefined
      ? `${ownerName}/${stringValue(value.name)}`
      : undefined);
  if (nameWithOwner === undefined || !nameWithOwner.includes("/")) return undefined;
  const [owner, ...nameParts] = nameWithOwner.split("/");
  const name = stringValue(value.name) ?? nameParts.join("/");
  if (owner === undefined || name === "") return undefined;
  const repository: GitHubRepository = { owner, name, nameWithOwner };
  const url = stringValue(value.html_url) ?? stringValue(value.url);
  const defaultBranch = stringValue(nested(value.defaultBranchRef, "name")) ?? stringValue(value.default_branch);
  return {
    ...repository,
    ...(url === undefined ? {} : { url }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
  };
}

function parseRepositoryFromRemote(stdout: string): GitHubRepository | undefined {
  const remote = stdout.trim().split("\n")[0]?.trim();
  if (remote === undefined || remote === "") return undefined;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const owner = match[1];
  const name = match[2];
  return { owner, name, nameWithOwner: `${owner}/${name}` };
}

function normalizeStatus(value: unknown): string {
  return (stringValue(value) ?? "").toLowerCase();
}

function authenticatedHostState(value: unknown): boolean {
  const state = normalizeStatus(value);
  return state === "" || ["authenticated", "authorized", "active", "success", "logged_in", "logged-in"].includes(state);
}

function parseCheck(value: unknown): GitHubCheck | undefined {
  if (!isObject(value)) return undefined;
  const name = stringValue(value.name) ?? stringValue(value.context) ?? "check";
  const status = normalizeStatus(value.status ?? value.state ?? value.bucket);
  const rawConclusion = stringValue(value.conclusion) ?? stringValue(value.bucket);
  const conclusion = rawConclusion === undefined ? undefined : normalizeStatus(rawConclusion);
  const url = stringValue(value.detailsUrl) ?? stringValue(value.url) ?? stringValue(value.target_url);
  return {
    name,
    status: status === "" ? "unknown" : status,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(url === undefined ? {} : { url }),
  };
}

function isPendingCheck(check: GitHubCheck): boolean {
  return ["queued", "in_progress", "in-progress", "pending", "requested", "waiting", "running", "unknown"].includes(check.status) ||
    ["queued", "in_progress", "in-progress", "pending", "requested", "waiting", "running"].includes(check.conclusion ?? "");
}

function isFailedCheck(check: GitHubCheck): boolean {
  return [
    "failure", "failed", "fail", "error", "errored", "cancel", "cancelled", "canceled", "stale",
    "timed_out", "timed-out", "action_required", "action-required", "startup_failure", "startup-failure",
  ].includes(check.status) || [
    "failure", "failed", "fail", "error", "errored", "cancel", "cancelled", "canceled", "stale",
    "timed_out", "timed-out", "action_required", "action-required", "startup_failure", "startup-failure",
  ].includes(check.conclusion ?? "");
}

function checksSummary(checks: readonly GitHubCheck[]): GitHubChecksSummary {
  const pending = checks.filter(isPendingCheck).length;
  const failed = checks.filter(isFailedCheck).length;
  const passed = checks.filter(isSuccessfulCheck).length;
  return {
    state: pending > 0 ? "pending" : failed > 0 ? "failure" : passed > 0 ? "success" : "neutral",
    total: checks.length,
    passed,
    failed,
    pending,
  };
}

function isSuccessfulCheck(check: GitHubCheck): boolean {
  return ["pass", "passed", "success"].includes(check.status) ||
    ["pass", "passed", "success"].includes(check.conclusion ?? "");
}

function parseChecks(value: unknown): GitHubCheck[] {
  const source = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.checks)
      ? value.checks
      : isObject(value) && Array.isArray(value.statusCheckRollup)
        ? value.statusCheckRollup
        : isObject(value) && Array.isArray(value.check_runs)
          ? value.check_runs
          : [];
  return source.map(parseCheck).filter((item): item is GitHubCheck => item !== undefined);
}

const RAW_CHECK_STATUSES = new Set([
  "pass", "passed", "success", "fail", "failed", "failure", "error", "errored", "cancel", "cancelled", "canceled",
  "pending", "queued", "requested", "waiting", "running", "in_progress", "in-progress", "stale", "timed_out", "timed-out",
  "action_required", "action-required", "startup_failure", "startup-failure", "skipping", "skipped", "neutral",
]);

function parseRawChecks(stdout: string): GitHubCheck[] {
  return stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(all checks|no checks|some checks were not successful)/i.test(line))
    .map((line) => {
      const parts = line.split(/\s+/);
      const urlIndex = parts.findIndex((part) => /^https?:\/\//i.test(part));
      const tableParts = urlIndex < 0 ? parts : parts.slice(0, urlIndex);
      const statusIndex = tableParts.reduce((last, part, index) => RAW_CHECK_STATUSES.has(normalizeStatus(part)) ? index : last, -1);
      if (statusIndex < 0) {
        return { name: tableParts.join(" ") || "check", status: "unknown" };
      }
      const nameParts = tableParts.slice(0, statusIndex);
      if (/^[✓✔✗×⨯✕Xx○◯\-!]$/.test(nameParts[0] ?? "")) nameParts.shift();
      return {
        name: nameParts.join(" ") || "check",
        status: normalizeStatus(tableParts[statusIndex]),
      };
    });
}

function parseReview(value: unknown): GitHubReview | undefined {
  if (!isObject(value)) return undefined;
  const state = stringValue(value.state) ?? "PENDING";
  const author = stringValue(nested(value.author, "login")) ?? stringValue(nested(value.user, "login"));
  return {
    ...(author === undefined ? {} : { author }),
    state,
    ...(stringValue(value.submittedAt) === undefined && stringValue(value.submitted_at) === undefined
      ? {}
      : { submittedAt: (stringValue(value.submittedAt) ?? stringValue(value.submitted_at)) as string }),
  };
}

function parseReviews(value: unknown): GitHubReview[] {
  const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.reviews) ? value.reviews : [];
  return source.map(parseReview).filter((item): item is GitHubReview => item !== undefined);
}

function reviewsSummary(reviews: readonly GitHubReview[], decision?: string): GitHubReviewsSummary {
  return {
    ...(decision === undefined ? {} : { decision }),
    approved: reviews.filter((review) => ["approved", "approve"].includes(review.state.toLowerCase())).length,
    changesRequested: reviews.filter((review) => ["changes_requested", "changes-requested"].includes(review.state.toLowerCase())).length,
    pending: reviews.filter((review) => ["pending", "commented"].includes(review.state.toLowerCase())).length,
  };
}

function parsePullRequest(value: unknown): GitHubPullRequest | undefined {
  if (!isObject(value)) return undefined;
  const number = numberValue(value.number);
  if (number === undefined) return undefined;
  const checks = parseChecks(value.statusCheckRollup ?? value.checks ?? value.check_runs);
  const reviews = Array.isArray(value.reviews)
    ? value.reviews.map(parseReview).filter((item): item is GitHubReview => item !== undefined)
    : [];
  const title = stringValue(value.title);
  const state = stringValue(value.state);
  const url = stringValue(value.url) ?? stringValue(value.html_url);
  const isDraft = booleanValue(value.isDraft) ?? booleanValue(value.draft);
  const headRefName = stringValue(value.headRefName) ?? stringValue(nested(value.head, "ref"));
  const headRefOid = stringValue(value.headRefOid) ?? stringValue(nested(value.head, "sha"));
  const headRepositoryNameWithOwner = stringValue(value.headRepositoryNameWithOwner) ??
    stringValue(nested(value.headRepository, "nameWithOwner")) ??
    stringValue(nested(value.headRepository, "full_name")) ??
    stringValue(value.headRepository) ??
    stringValue(nested(nested(value.head, "repo"), "full_name"));
  const headRepositoryOwner = stringValue(nested(value.headRepositoryOwner, "login")) ??
    stringValue(nested(value.headRepositoryOwner, "name")) ??
    stringValue(value.headRepositoryOwner) ??
    (headRepositoryNameWithOwner?.split("/")[0]) ??
    stringValue(nested(nested(value.head, "user"), "login"));
  const baseRefName = stringValue(value.baseRefName) ?? stringValue(nested(value.base, "ref"));
  const baseRefOid = stringValue(value.baseRefOid) ?? stringValue(nested(value.base, "sha"));
  return {
    number,
    ...(title === undefined ? {} : { title }),
    ...(state === undefined ? {} : { state }),
    ...(url === undefined ? {} : { url }),
    ...(isDraft === undefined ? {} : { isDraft }),
    ...(headRefName === undefined ? {} : { headRefName }),
    ...(headRefOid === undefined ? {} : { headRefOid }),
    ...(headRepositoryOwner === undefined ? {} : { headRepositoryOwner }),
    ...(headRepositoryNameWithOwner === undefined ? {} : { headRepositoryNameWithOwner }),
    ...(baseRefName === undefined ? {} : { baseRefName }),
    ...(baseRefOid === undefined ? {} : { baseRefOid }),
    checks,
    checksSummary: checksSummary(checks),
    reviews,
    reviewsSummary: reviewsSummary(reviews, stringValue(value.reviewDecision)),
  };
}

function parseIssue(value: unknown): GitHubIssue | undefined {
  if (!isObject(value)) return undefined;
  const number = numberValue(value.number);
  if (number === undefined) return undefined;
  const labels = Array.isArray(value.labels)
    ? value.labels.map((label) => stringValue(nested(label, "name")) ?? stringValue(label)).filter((item): item is string => item !== undefined)
    : [];
  const assignees = Array.isArray(value.assignees)
    ? value.assignees.map((assignee) => stringValue(nested(assignee, "login")) ?? stringValue(assignee)).filter((item): item is string => item !== undefined)
    : [];
  const title = stringValue(value.title);
  const state = stringValue(value.state);
  const url = stringValue(value.url);
  return {
    number,
    ...(title === undefined ? {} : { title }),
    ...(state === undefined ? {} : { state }),
    ...(url === undefined ? {} : { url }),
    ...(labels.length === 0 ? {} : { labels }),
    ...(assignees.length === 0 ? {} : { assignees }),
  };
}

function parsePullRequests(value: unknown): GitHubPullRequest[] {
  if (!Array.isArray(value)) return [];
  return value.map(parsePullRequest).filter((item): item is GitHubPullRequest => item !== undefined);
}

function parseDependencyNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => numberValue(nested(entry, "number")) ?? numberValue(entry)).filter((item): item is number => item !== undefined);
}

function mergeDependencies(issue: number, blockedBy: readonly number[], blocking: readonly number[]): GitHubIssueDependencies {
  return { issue, blockedBy: [...new Set(blockedBy)], blocking: [...new Set(blocking)] };
}

function labelStatus(issue: GitHubIssue, dependencies: GitHubIssueDependencies): GitHubWorkItem["status"] {
  if ((issue.state ?? "").toLowerCase() === "closed") return "completed";
  if (dependencies.state === "unknown") return "unknown";
  if (dependencies.blockedBy.length > 0) return "blocked";
  const labels = (issue.labels ?? []).map((label) => label.toLowerCase().replaceAll("-", "_").replaceAll(":", "_"));
  if (labels.some((label) => label.includes("in_progress") || label.includes("agent_running") || label.includes("doing"))) return "in_progress";
  return "ready";
}

function summarizeWork(items: readonly GitHubWorkItem[], dependencies: readonly GitHubIssueDependencies[]): GitHubWorkSnapshot {
  const ids = (status: GitHubWorkItem["status"]): number[] => items.filter((item) => item.status === status).map((item) => item.number);
  return {
    items,
    dependencies,
    ready: ids("ready"),
    blocked: ids("blocked"),
    inProgress: ids("in_progress"),
    completed: ids("completed"),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function rawCommand(args: readonly string[]): string {
  return ["gh", ...args].map(shellQuote).join(" ");
}

function parseVersion(stdout: string): string | undefined {
  return /gh version\s+([^\s]+)/i.exec(stdout)?.[1];
}

function eventMetrics(event: { readonly durationMs: number; readonly internalCalls: number; readonly retries: number; readonly pollCountInternal: number; readonly pollCountModel: number; readonly inputBytes: number; readonly rawOutputBytes: number; readonly returnedOutputBytes: number; readonly artifactBytes: number; readonly filesRead: number; readonly filesChanged: number; readonly compressionRatio: number }): OperationMeasurements {
  return {
    durationMs: event.durationMs,
    internalCalls: event.internalCalls,
    retries: event.retries,
    pollCountInternal: event.pollCountInternal,
    pollCountModel: event.pollCountModel,
    inputBytes: event.inputBytes,
    rawOutputBytes: event.rawOutputBytes,
    returnedOutputBytes: event.returnedOutputBytes,
    artifactBytes: event.artifactBytes,
    filesRead: event.filesRead,
    filesChanged: event.filesChanged,
    compressionRatio: event.compressionRatio,
  };
}

export class GitHubProvider {
  readonly direct: DirectExecutor;
  readonly tracer: Tracer;
  readonly runner: GitHubCommandRunner;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly maxOutputBytes: number;

  constructor(options: GitHubProviderOptions = {}) {
    this.direct = options.direct ?? new DirectExecutor();
    this.tracer = options.tracer ?? this.direct.tracer;
    this.maxOutputBytes = options.maxOutputBytes ?? GH_OUTPUT_LIMIT;
    this.runner = options.runner ?? new DirectGitHubCommandRunner(this.direct, this.maxOutputBytes);
    this.sleep = options.sleep ?? ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("GitHub wait was cancelled"));
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("GitHub wait was cancelled"));
      }, { once: true });
    }));
  }

  async capabilities(input: GitHubCapabilityInput = {}, context: OperationContext = defaultContext(), options: { readonly instrument?: boolean } = {}): Promise<GitHubOperationResult<GitHubCapabilities>> {
    return this.runOperation("github.capabilities", "read", context, async (metrics, operationContext) => {
      const routes = new Set<GitHubProviderRoute>();
      const version = await this.tryVersion(input.cwd, operationContext, metrics);
      if (version === undefined) {
        return { data: unavailableCapabilities("gh is not available"), summary: "GitHub CLI unavailable" };
      }
      const auth = await this.tryAuth(input.cwd, operationContext, metrics, routes);
      const repository = await this.readRepository(input.cwd, operationContext, metrics, routes);
      const capabilities: GitHubCapabilities = {
        available: true,
        ghAvailable: true,
        authenticated: auth.authenticated,
        ...(auth.account === undefined ? {} : { account: auth.account }),
        ...(repository === undefined ? {} : { repository, currentRepository: repository }),
        version,
        structuredJson: routes.has("gh-json"),
        api: routes.has("gh-api"),
        rawGh: true,
        routes: routeList(routes, true),
        ...(repository === undefined ? { error: "Current repository is unavailable" } : {}),
      };
      return { data: capabilities, summary: "GitHub capabilities detected" };
    }, options);
  }

  /** Alias matching capability-provider terminology used by other adapters. */
  detectCapabilities(cwd = "", context: OperationContext = defaultContext()): Promise<GitHubOperationResult<GitHubCapabilities>> {
    return this.capabilities({ cwd }, context);
  }

  async snapshot(input: GitHubSnapshotInput = {}, context: OperationContext = defaultContext(), options: { readonly instrument?: boolean } = {}): Promise<GitHubOperationResult<GitHubSnapshot>> {
    const cwd = input.cwd ?? input.rootDir;
    return this.runOperation("github.snapshot", "network", context, async (metrics, operationContext) => {
      const routes = new Set<GitHubProviderRoute>();
      const repositoryAttempt = await this.readRepositoryAttempt(cwd, operationContext, metrics, routes);
      const repository = repositoryAttempt?.value;
      if (repository === undefined) {
        return {
          data: { available: false, route: routeList(routes, false)[0] ?? "unavailable", error: "Current GitHub repository is unavailable" },
          summary: "GitHub repository unavailable",
        };
      }

      const branch = await this.gitText(["branch", "--show-current"], cwd, operationContext, metrics);
      const head = await this.gitText(["rev-parse", "HEAD"], cwd, operationContext, metrics);
      const pullRequestAttempt = await this.readCurrentPullRequest(cwd, repository, operationContext, metrics, routes);
      const pullRequest = pullRequestAttempt?.value;
      const issueNumber = input.issueNumber;
      const issue = issueNumber === undefined
        ? undefined
        : (await this.readIssue(repository, issueNumber, cwd, operationContext, metrics, routes))?.value;
      const dependencies = issueNumber === undefined
        ? undefined
        : await this.readIssueDependencies(repository, issueNumber, cwd, operationContext, metrics, routes);
      const work = input.includeWork === true || (input.issueNumbers?.length ?? 0) > 0
        ? await this.readWork(repository, input.issueNumbers ?? (issueNumber === undefined ? [] : [issueNumber]), cwd, operationContext, metrics, routes)
        : undefined;
      const route = routeList(routes, false)[0] ?? repositoryAttempt?.route ?? "gh-json";
      const data: GitHubSnapshot = {
        available: true,
        repository,
        ...(branch === undefined ? {} : { currentBranch: branch }),
        ...(head === undefined ? {} : { currentHead: head }),
        ...(pullRequest === undefined ? {} : { currentPullRequest: pullRequest, checks: pullRequest.checksSummary, reviews: pullRequest.reviewsSummary }),
        ...(issue === undefined ? {} : { issue }),
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(work === undefined ? {} : { work }),
        route,
      };
      return { data, summary: "GitHub state snapshot compressed" };
    }, options);
  }

  async wait(input: GitHubWaitInput = {}, context: OperationContext = defaultContext(), options: { readonly instrument?: boolean } = {}): Promise<GitHubOperationResult<GitHubWaitResult>> {
    return this.runOperation("github.wait", "network", context, async (metrics, operationContext) => {
      const routes = new Set<GitHubProviderRoute>();
      const intervalMs = nonNegativeInteger(input.intervalMs, DEFAULT_WAIT_INTERVAL_MS);
      const timeoutMs = nonNegativeInteger(input.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
      const maxPolls = positiveInteger(input.maxPolls, DEFAULT_WAIT_MAX_POLLS);
      const deadline = Math.min(Date.now() + timeoutMs, contextDeadline(operationContext));
      // DirectExecutor applies the context deadline to every child process.
      // This is important for the raw shell escape hatch, whose command must
      // never be allowed to outlive this semantic wait operation.
      const waitContext = withDeadline(operationContext, deadline);
      let repository: GitHubRepository | undefined;
      let pullRequestNumber = parsePullRequestNumber(input.pullRequest);
      if (pullRequestNumber === undefined) {
        const repositoryAttempt = await this.readRepositoryAttempt(input.cwd, waitContext, metrics, routes);
        repository = repositoryAttempt?.value;
        const current = await this.readCurrentPullRequest(input.cwd, repository, waitContext, metrics, routes);
        pullRequestNumber = current?.value.number;
      } else {
        const repositoryAttempt = await this.readRepositoryAttempt(input.cwd, waitContext, metrics, routes);
        repository = repositoryAttempt?.value;
      }
      if (pullRequestNumber === undefined) {
        throw createRuntimeError({ code: "GITHUB_PR_NOT_FOUND", message: "No current pull request was found", retryable: false, effect: "none" });
      }

      let lastChecks: readonly GitHubCheck[] = [];
      for (let poll = 0; poll < maxPolls; poll += 1) {
        if (waitContext.signal.aborted) throw createRuntimeError({ code: "GITHUB_WAIT_CANCELLED", message: "GitHub wait was cancelled", retryable: false, effect: "none" });
        if (Date.now() >= deadline) break;
        metrics.pollCountInternal += 1;
        const checksAttempt = await this.readChecks(pullRequestNumber, repository, input.cwd, waitContext, metrics, routes, deadline);
        if (checksAttempt === undefined) {
          throw createRuntimeError({ code: "GITHUB_CHECKS_UNAVAILABLE", message: "Pull request checks could not be read", retryable: true, effect: "none" });
        }
        lastChecks = checksAttempt.value;
        const summary = checksSummary(lastChecks);
        const terminal = summary.pending === 0;
        const passed = terminal && summary.state === "success" && summary.passed > 0;
        // A terminal failure is final even for checks_passed: return it to the
        // caller instead of polling until the deadline can only produce a
        // misleading timeout.
        if (terminal) {
          return {
            data: {
              pullRequest: pullRequestNumber,
              terminal,
              passed,
              checks: lastChecks,
              checksSummary: summary,
              pollCountInternal: metrics.pollCountInternal,
              pollCountModel: 0,
              timedOut: false,
            },
            summary: "GitHub checks reached a terminal state",
          };
        }
        const remainingMs = deadline - Date.now();
        if (poll + 1 < maxPolls && intervalMs > 0 && remainingMs > 0) {
          await this.sleep(Math.min(intervalMs, remainingMs), waitContext.signal);
        }
      }
      const summary = checksSummary(lastChecks);
      throw createRuntimeError({
        code: "GITHUB_WAIT_TIMEOUT",
        message: "GitHub checks did not reach the requested state before the wait deadline",
        retryable: true,
        effect: "none",
        details: { pullRequest: pullRequestNumber, pollCountInternal: metrics.pollCountInternal, checks: summary },
      });
    }, options);
  }

  async work(input: GitHubWorkInput, context: OperationContext = defaultContext(), options: { readonly instrument?: boolean } = {}): Promise<GitHubOperationResult<GitHubWorkSnapshot>> {
    return this.runOperation("github.work", "network", context, async (metrics, operationContext) => {
      const routes = new Set<GitHubProviderRoute>();
      const repository = (await this.readRepositoryAttempt(input.cwd, operationContext, metrics, routes))?.value;
      if (repository === undefined) {
        throw createRuntimeError({ code: "GITHUB_REPOSITORY_NOT_FOUND", message: "Current GitHub repository was not found", retryable: false, effect: "none" });
      }
      const data = await this.readWork(repository, input.issueNumbers, input.cwd, operationContext, metrics, routes);
      return { data, summary: "GitHub dependency work snapshot compressed" };
    }, options);
  }

  async publish(input: GitHubPublishInput, context: OperationContext = defaultContext(), options: { readonly instrument?: boolean } = {}): Promise<GitHubOperationResult<GitHubEffectReceipt>> {
    return this.runOperation("github.publish", "remote", context, async (metrics, operationContext) => {
      const cwd = input.cwd;
      const routes = new Set<GitHubProviderRoute>();
      const repositoryAttempt = await this.readRepositoryAttempt(cwd, operationContext, metrics, routes);
      const repository = repositoryAttempt?.value;
      if (repository === undefined) {
        throw createRuntimeError({ code: "GITHUB_REPOSITORY_NOT_FOUND", message: "Current GitHub repository was not found", retryable: false, effect: "none" });
      }
      const remote = input.remote ?? "origin";
      const branch = input.branch ?? await this.gitText(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, operationContext, metrics);
      const localHead = await this.gitText(["rev-parse", "HEAD"], cwd, operationContext, metrics);
      if (branch === undefined || localHead === undefined) {
        throw createRuntimeError({ code: "GITHUB_LOCAL_HEAD_UNAVAILABLE", message: "A named local branch and HEAD are required to publish", retryable: false, effect: "none" });
      }
      const base = input.base ?? repository.defaultBranch ?? "main";
      let remoteHead = await this.remoteHead(remote, branch, cwd, operationContext, metrics);
      let pushed = false;
      let reconciled = false;
      if (remoteHead !== localHead) {
        try {
          await this.gitCommand(["push", remote, `HEAD:refs/heads/${branch}`], cwd, operationContext, metrics);
          pushed = true;
        } catch (cause) {
          // A completed push can still return an ambiguous transport error.
          let freshRemoteHead: string | undefined;
          try {
            freshRemoteHead = await this.remoteHead(remote, branch, cwd, operationContext, metrics);
          } catch {
            throw createRuntimeError({ code: "GITHUB_PUSH_UNKNOWN", message: "The push response was ambiguous and remote reconciliation failed", retryable: true, effect: "unknown" });
          }
          if (freshRemoteHead === localHead) {
            remoteHead = freshRemoteHead;
            pushed = true;
            reconciled = true;
          } else {
            throw errorWithEffect(cause, "GITHUB_PUSH_UNKNOWN", "unknown");
          }
        }
        try {
          remoteHead = await this.remoteHead(remote, branch, cwd, operationContext, metrics);
        } catch (cause) {
          // The push completed, so a failed post-push read is applied but not
          // reconciled. Preserve that effect state for the operation result.
          throw errorWithEffect(cause, "GITHUB_REMOTE_HEAD_UNKNOWN", "applied");
        }
        if (remoteHead !== localHead) {
          throw createRuntimeError({ code: "GITHUB_REMOTE_HEAD_MISMATCH", message: "Remote branch does not match the local HEAD after push", retryable: true, effect: pushed ? "applied" : "unknown", details: { branch, localHead, remoteHead } });
        }
        reconciled = true;
      }

      let pullRequest = (await this.findPullRequest(repository, branch, cwd, operationContext, metrics, routes))?.value;
      let created = false;
      let pullRequestEffectState: EffectState = "none";
      if (pullRequest === undefined) {
        try {
          const createResult = await this.createPullRequest(repository, branch, base, input.title, input.body ?? "", cwd, operationContext, metrics, routes);
          created = createResult.created;
          pullRequest = createResult.pullRequest;
          pullRequestEffectState = createResult.effectState ?? "none";
          if (!created) reconciled = true;
        } catch (cause) {
          // Never issue a blind second create after an ambiguous response.
          pullRequest = (await this.findPullRequest(repository, branch, cwd, operationContext, metrics, routes, { reconcileAfterEmpty: true }))?.value;
          if (pullRequest === undefined) throw errorFor(cause, "GITHUB_PR_CREATE_UNKNOWN", "unknown");
          pullRequestEffectState = "unknown";
          reconciled = true;
        }
        pullRequest ??= (await this.findPullRequest(repository, branch, cwd, operationContext, metrics, routes))?.value;
      }
      if (pullRequest === undefined) {
        throw createRuntimeError({ code: "GITHUB_PR_NOT_FOUND_AFTER_PUBLISH", message: "Pull request could not be read after publish", retryable: true, effect: pullRequestEffectState === "unknown" ? "unknown" : created || pushed ? "applied" : "none" });
      }
      const publishEffectState: EffectState = pullRequestEffectState === "unknown"
        ? "unknown"
        : pushed || created
          ? "applied"
          : "none";
      const freshPullRequest = (await this.readPullRequest(repository, pullRequest.number, cwd, operationContext, metrics, routes))?.value;
      if (freshPullRequest === undefined) {
        throw createRuntimeError({ code: "GITHUB_PR_FRESH_READ_FAILED", message: "Pull request could not be freshly reconciled after publish", retryable: true, effect: publishEffectState, details: { pullRequest: pullRequest.number } });
      }
      if (freshPullRequest.headRefOid !== localHead) {
        throw createRuntimeError({ code: "GITHUB_PR_HEAD_MISMATCH", message: "Pull request head does not match the reconciled remote HEAD", retryable: true, effect: publishEffectState, details: { pullRequest: freshPullRequest.number, localHead, pullRequestHead: freshPullRequest.headRefOid } });
      }
      if (freshPullRequest.baseRefName !== base) {
        throw createRuntimeError({ code: "GITHUB_PR_BASE_MISMATCH", message: "Existing pull request targets a different base branch", retryable: false, effect: publishEffectState, details: { expected: base, actual: freshPullRequest.baseRefName } });
      }
      return {
        data: {
          operation: "github.publish",
          repository,
          branch,
          localHead,
          remoteHead,
          pushed,
          pullRequest: freshPullRequest,
          created,
          reused: !created,
          reconciled: reconciled || remoteHead === localHead,
          effectState: publishEffectState,
        },
        effectState: publishEffectState,
        summary: created ? "Branch published and pull request created" : pushed ? "Branch published and pull request reused" : "Remote branch and pull request already reconciled",
      };
    }, options);
  }

  private async runOperation<T>(
    operation: string,
    effectClass: EffectClass,
    context: OperationContext,
    work: (metrics: ProviderMetrics, operationContext: OperationContext) => Promise<ProviderWorkResult<T>>,
    options: { readonly instrument?: boolean } = {},
  ): Promise<RuntimeResult<T>> {
    const startedAt = this.tracer.now().toISOString();
    const span = options.instrument === false ? undefined : this.tracer.startOperation({
      traceId: context.traceId,
      runId: context.runId,
      actor: context.actor,
      operation,
      effectClass,
      ...(context.spanId === undefined ? {} : { parentSpanId: context.spanId }),
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
      executor: "direct",
      provider: "github",
    });
    const operationContext = span === undefined ? context : createOperationContext({
      ...context,
      spanId: span.spanId,
      ...(context.spanId === undefined ? {} : { parentSpanId: context.spanId }),
    });
    const metrics = new ProviderMetrics();
    try {
      if (!isEffectAllowed(operationContext.effectPolicy, effectClass)) {
        throw createRuntimeError({ code: "EFFECT_NOT_ALLOWED", message: `GitHub operation ${operation} is not allowed by the execution policy`, retryable: false, effect: "none" });
      }
      if (requiresApproval(operationContext.effectPolicy, effectClass)) {
        throw createRuntimeError({ code: "EFFECT_APPROVAL_REQUIRED", message: `GitHub operation ${operation} requires approval`, retryable: false, effect: "none" });
      }
      const result = await work(metrics, operationContext);
      const artifactRefs = result.artifactRefs ?? metrics.artifactRefs;
      const truncated = result.truncated ?? metrics.truncated;
      metrics.setReturnedOutputBytes(byteLength(JSON.stringify(result.data) ?? ""));
      const snapshot = metrics.snapshot();
      span?.record(snapshot);
      const event = span?.complete({
        effectState: result.effectState ?? "none",
        artifactRefs,
        ...(result.summary === undefined ? {} : { summary: result.summary }),
      });
      return runtimeSuccess(result.data, createOperationMeta({
        context: operationContext,
        operation,
        status: "completed",
        effectClass,
        effectState: result.effectState ?? "none",
        startedAt: span?.startedAt ?? startedAt,
        completedAt: event?.timestamp ?? this.tracer.now().toISOString(),
        metrics: event === undefined ? snapshot : eventMetrics(event),
        artifactRefs,
        truncated,
        executor: "direct",
        provider: "github",
      }));
    } catch (cause) {
      const error = errorFor(cause, "GITHUB_OPERATION_FAILED", effectClass === "remote" ? "unknown" : "none");
      const snapshot = metrics.snapshot();
      span?.record(snapshot);
      const event = span === undefined
        ? undefined
        : error.effect === "unknown" ? span.unknown(error, { artifactRefs: metrics.artifactRefs }) : span.fail(error, { artifactRefs: metrics.artifactRefs });
      return runtimeFailure(error, createOperationMeta({
        context: operationContext,
        operation,
        status: error.effect === "unknown" ? "unknown" : "failed",
        effectClass,
        effectState: error.effect,
        startedAt: span?.startedAt ?? startedAt,
        completedAt: event?.timestamp ?? this.tracer.now().toISOString(),
        metrics: event === undefined ? snapshot : eventMetrics(event),
        artifactRefs: metrics.artifactRefs,
        truncated: metrics.truncated,
        executor: "direct",
        provider: "github",
      }));
    }
  }

  private async execute(args: readonly string[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics): Promise<GitHubCommandResult> {
    metrics.call({ executable: "gh", args, cwd });
    const result = await this.runner.runExecutable({ executable: "gh", args: [...args], ...(cwd === undefined ? {} : { cwd }), maxOutputBytes: this.maxOutputBytes }, context);
    metrics.observe(result);
    return result;
  }

  private async shell(args: readonly string[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, options: { readonly timeoutMs?: number } = {}): Promise<GitHubCommandResult> {
    const command = rawCommand(args);
    metrics.call({ shell: command, cwd });
    const result = await this.runner.runShell({ command, ...(cwd === undefined ? {} : { cwd }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), maxOutputBytes: this.maxOutputBytes }, context);
    metrics.observe(result);
    return result;
  }

  private async gitCommand(args: readonly string[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics): Promise<GitHubCommandResult> {
    metrics.call({ executable: "git", args, cwd });
    const result = await this.runner.runExecutable({ executable: "git", args: [...args], ...(cwd === undefined ? {} : { cwd }), maxOutputBytes: this.maxOutputBytes }, context);
    metrics.observe(result);
    if ((result.exitCode ?? 0) !== 0) {
      throw createRuntimeError({ code: "GIT_COMMAND_FAILED", message: result.stderr.trim() || `git ${args.join(" ")} failed`, retryable: false, effect: "none", details: { args: [...args], exitCode: result.exitCode } });
    }
    return result;
  }

  private async gitText(args: readonly string[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics): Promise<string | undefined> {
    try {
      const result = await this.gitCommand(args, cwd, context, metrics);
      const value = result.stdout.trim();
      return value === "" ? undefined : value;
    } catch {
      return undefined;
    }
  }

  private async tryVersion(cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics): Promise<string | undefined> {
    try {
      const result = await this.execute(["--version"], cwd, context, metrics);
      return (result.exitCode ?? 0) === 0 ? parseVersion(result.stdout) ?? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private async tryAuth(cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<{ authenticated: boolean; account?: string }> {
    try {
      const result = await this.execute(["auth", "status", "--json", "hosts"], cwd, context, metrics);
      if ((result.exitCode ?? 0) === 0) {
        const parsed = parseJson(result.stdout);
        const hosts = nested(parsed, "hosts");
        const githubHosts = Array.isArray(hosts) ? hosts : nested(hosts, "github.com");
        routes.add("gh-json");
        const active = Array.isArray(githubHosts)
          ? githubHosts.find((host) => isObject(host) && booleanValue(host.active) === true && authenticatedHostState(host.state))
          : undefined;
        if (active !== undefined) {
          const account = stringValue(active.login) ?? stringValue(active.user);
          return { authenticated: true, ...(account === undefined ? {} : { account }) };
        }
      }
    } catch {
      // Fall through to the authenticated API identity check.
    }
    const api = await this.apiJson("user", [], cwd, context, metrics);
    if (api === undefined) return { authenticated: false };
    routes.add(api.route);
    const account = stringValue(nested(api.value, "login")) ?? stringValue(nested(api.value, "name"));
    return { authenticated: true, ...(account === undefined ? {} : { account }) };
  }

  private async readRepository(cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<GitHubRepository | undefined> {
    return (await this.readRepositoryAttempt(cwd, context, metrics, routes))?.value;
  }

  private async readRepositoryAttempt(cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<Attempt<GitHubRepository> | undefined> {
    const structured = await this.jsonCommand(["repo", "view", "--json", REPO_JSON_FIELDS], cwd, context, metrics);
    if (structured !== undefined) {
      const repository = parseRepository(structured.value);
      if (repository !== undefined) {
        routes.add("gh-json");
        return { value: repository, route: "gh-json" };
      }
    }
    const remoteResult = await this.gitText(["remote", "get-url", "origin"], cwd, context, metrics);
    const fromRemote = remoteResult === undefined ? undefined : parseRepositoryFromRemote(remoteResult);
    if (fromRemote !== undefined) {
      const api = await this.apiJson(`repos/${repositoryPath(fromRemote)}`, [], cwd, context, metrics);
      if (api !== undefined) {
        // REST uses html_url/default_branch/full_name, while gh --json uses
        // url/defaultBranchRef/nameWithOwner. Normalize before parsing so the
        // publish base branch remains the repository's actual default.
        const repository = parseRepository(api.value) ?? {
          ...fromRemote,
          ...(stringValue(nested(api.value, "html_url")) === undefined ? {} : { url: stringValue(nested(api.value, "html_url")) as string }),
          ...(stringValue(nested(api.value, "default_branch")) === undefined ? {} : { defaultBranch: stringValue(nested(api.value, "default_branch")) as string }),
        };
        routes.add(api.route);
        return { value: repository, route: api.route };
      }
      // The git remote identifies the repository, but a failed API read must
      // not advertise gh-api as an available provider route.
      return { value: fromRemote, route: "unavailable" };
    }
    return undefined;
  }

  private async jsonCommand(args: readonly string[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics): Promise<Attempt<unknown> | undefined> {
    try {
      const result = await this.execute(args, cwd, context, metrics);
      if ((result.exitCode ?? 0) === 0) {
        const value = parseJson(result.stdout);
        if (value !== undefined) return { value, route: "gh-json" };
      }
    } catch {
      // The API and raw shell routes are the documented fallbacks.
    }
    return undefined;
  }

  private async apiJson(endpoint: string, args: readonly string[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, allowRawFallback = true): Promise<Attempt<unknown> | undefined> {
    const commandArgs = ["api", endpoint, ...args];
    try {
      const result = await this.execute(commandArgs, cwd, context, metrics);
      if ((result.exitCode ?? 0) === 0) {
        const value = parseJson(result.stdout);
        if (value !== undefined) return { value, route: "gh-api" };
      }
    } catch {
      // Continue to the raw gh shell escape hatch.
    }
    if (!allowRawFallback) return undefined;
    try {
      const result = await this.shell(commandArgs, cwd, context, metrics);
      if ((result.exitCode ?? 0) === 0) {
        const value = parseJson(result.stdout);
        if (value !== undefined) return { value, route: "raw-gh" };
      }
    } catch {
      // The caller decides whether an unavailable read is best effort.
    }
    return undefined;
  }

  private async rawJson(args: readonly string[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics): Promise<Attempt<unknown> | undefined> {
    try {
      const result = await this.shell(args, cwd, context, metrics);
      if ((result.exitCode ?? 0) === 0) {
        const value = parseJson(result.stdout);
        if (value !== undefined) return { value, route: "raw-gh" };
      }
    } catch {
      // No further provider route exists.
    }
    return undefined;
  }

  private async readCurrentPullRequest(cwd: string | undefined, repository: GitHubRepository | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<Attempt<GitHubPullRequest> | undefined> {
    const structured = await this.jsonCommand(["pr", "view", "--json", PR_JSON_FIELDS], cwd, context, metrics);
    if (structured !== undefined) {
      const value = parsePullRequest(structured.value);
      if (value !== undefined) {
        routes.add("gh-json");
        return { value, route: "gh-json" };
      }
    }
    if (repository !== undefined) {
      const prs = await this.apiJson(`repos/${repositoryPath(repository)}/pulls?head=${encodeURIComponent(repository.owner + ":" + (await this.gitText(["branch", "--show-current"], cwd, context, metrics) ?? ""))}&state=open&per_page=1`, [], cwd, context, metrics);
      if (prs !== undefined) {
        const value = parsePullRequests(prs.value)[0];
        if (value !== undefined) {
          const enriched = await this.enrichApiPullRequest(repository, value, cwd, context, metrics, routes);
          routes.add(prs.route);
          return { value: enriched, route: prs.route };
        }
      }
    }
    const raw = await this.rawJson(["pr", "view", "--json", PR_JSON_FIELDS], cwd, context, metrics);
    if (raw !== undefined) {
      const value = parsePullRequest(raw.value);
      if (value !== undefined) {
        routes.add("raw-gh");
        return { value, route: "raw-gh" };
      }
    }
    return undefined;
  }

  private async readPullRequest(repository: GitHubRepository, number: number, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<Attempt<GitHubPullRequest> | undefined> {
    const structured = await this.jsonCommand(["pr", "view", String(number), "--json", PR_JSON_FIELDS], cwd, context, metrics);
    if (structured !== undefined) {
      const value = parsePullRequest(structured.value);
      if (value !== undefined) {
        routes.add("gh-json");
        return { value, route: "gh-json" };
      }
    }
    const api = await this.apiJson(`repos/${repositoryPath(repository)}/pulls/${number}`, [], cwd, context, metrics);
    if (api !== undefined) {
      const value = parsePullRequest(api.value);
      if (value !== undefined) {
        const enriched = await this.enrichApiPullRequest(repository, value, cwd, context, metrics, routes);
        routes.add(api.route);
        return { value: enriched, route: api.route };
      }
    }
    const raw = await this.rawJson(["pr", "view", String(number), "--json", PR_JSON_FIELDS], cwd, context, metrics);
    if (raw !== undefined) {
      const value = parsePullRequest(raw.value);
      if (value !== undefined) {
        routes.add("raw-gh");
        return { value, route: "raw-gh" };
      }
    }
    return undefined;
  }

  private async enrichApiPullRequest(repository: GitHubRepository, pullRequest: GitHubPullRequest, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<GitHubPullRequest> {
    let checks = pullRequest.checks;
    let reviews = pullRequest.reviews;
    const reviewsAttempt = await this.apiJson(`repos/${repositoryPath(repository)}/pulls/${pullRequest.number}/reviews`, [], cwd, context, metrics);
    if (reviewsAttempt !== undefined) {
      reviews = parseReviews(reviewsAttempt.value);
      routes.add(reviewsAttempt.route);
    }
    if (pullRequest.headRefOid !== undefined) {
      const checksAttempt = await this.apiJson(`repos/${repositoryPath(repository)}/commits/${pullRequest.headRefOid}/check-runs`, [], cwd, context, metrics);
      if (checksAttempt !== undefined) {
        checks = parseChecks(checksAttempt.value);
        routes.add(checksAttempt.route);
      }
    }
    return {
      ...pullRequest,
      checks,
      checksSummary: checksSummary(checks),
      reviews,
      reviewsSummary: reviewsSummary(reviews, pullRequest.reviewsSummary.decision),
    };
  }

  private async readIssue(repository: GitHubRepository, number: number, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<Attempt<GitHubIssue> | undefined> {
    const structured = await this.jsonCommand(["issue", "view", String(number), "--json", ISSUE_JSON_FIELDS], cwd, context, metrics);
    if (structured !== undefined) {
      const value = parseIssue(structured.value);
      if (value !== undefined) {
        routes.add("gh-json");
        return { value, route: "gh-json" };
      }
    }
    const api = await this.apiJson(`repos/${repositoryPath(repository)}/issues/${number}`, [], cwd, context, metrics);
    if (api !== undefined) {
      const value = parseIssue(api.value);
      if (value !== undefined) {
        routes.add(api.route);
        return { value, route: api.route };
      }
    }
    const raw = await this.rawJson(["issue", "view", String(number), "--json", ISSUE_JSON_FIELDS], cwd, context, metrics);
    if (raw !== undefined) {
      const value = parseIssue(raw.value);
      if (value !== undefined) {
        routes.add("raw-gh");
        return { value, route: "raw-gh" };
      }
    }
    return undefined;
  }

  private async readIssueDependencies(repository: GitHubRepository, number: number, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<GitHubIssueDependencies> {
    const blockedBy = await this.apiJson(`repos/${repositoryPath(repository)}/issues/${number}/dependencies/blocked_by`, [], cwd, context, metrics);
    const blocking = await this.apiJson(`repos/${repositoryPath(repository)}/issues/${number}/dependencies/blocking`, [], cwd, context, metrics);
    if (blockedBy !== undefined) routes.add(blockedBy.route);
    if (blocking !== undefined) routes.add(blocking.route);
    const blockedByNumbers = parseDependencyNumbers(blockedBy?.value);
    const blockingNumbers = parseDependencyNumbers(blocking?.value);
    const dependencies = mergeDependencies(number, blockedByNumbers ?? [], blockingNumbers ?? []);
    return blockedByNumbers !== undefined && blockingNumbers !== undefined
      ? dependencies
      : { ...dependencies, state: "unknown" };
  }

  private async readWork(repository: GitHubRepository, numbers: readonly number[], cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<GitHubWorkSnapshot> {
    const items: GitHubWorkItem[] = [];
    const dependencies: GitHubIssueDependencies[] = [];
    for (const number of [...new Set(numbers)].filter((item) => Number.isSafeInteger(item) && item > 0)) {
      const issue = (await this.readIssue(repository, number, cwd, context, metrics, routes))?.value;
      if (issue === undefined) continue;
      const dependency = await this.readIssueDependencies(repository, number, cwd, context, metrics, routes);
      dependencies.push(dependency);
      items.push({ ...issue, status: labelStatus(issue, dependency), blockedBy: dependency.blockedBy });
    }
    return summarizeWork(items, dependencies);
  }

  private async readChecks(number: number, repository: GitHubRepository | undefined, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>, deadline?: number): Promise<Attempt<GitHubCheck[]> | undefined> {
    const structured = await this.jsonCommand(["pr", "checks", String(number), "--json", "name,state,bucket,link"], cwd, context, metrics);
    if (structured !== undefined) {
      routes.add("gh-json");
      return { value: parseChecks(structured.value), route: "gh-json" };
    }
    if (repository !== undefined) {
      const pr = await this.apiJson(`repos/${repositoryPath(repository)}/pulls/${number}`, [], cwd, context, metrics);
      const sha = stringValue(nested(nested(pr?.value, "head"), "sha"));
      if (sha !== undefined) {
        const checks = await this.apiJson(`repos/${repositoryPath(repository)}/commits/${sha}/check-runs`, [], cwd, context, metrics);
        if (checks !== undefined) {
          routes.add(checks.route);
          return { value: parseChecks(checks.value), route: checks.route };
        }
      }
    }
    const timeoutMs = deadline === undefined || !Number.isFinite(deadline) ? undefined : Math.max(1, deadline - Date.now());
    // Keep raw gh as an escape hatch, but leave polling to AER. The --watch
    // mode owns an unbounded loop and can therefore exceed the operation's
    // timeout; the per-command timeout is the final safety boundary.
    const raw = await this.shell(
      ["pr", "checks", String(number)],
      cwd,
      context,
      metrics,
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    const checks = parseRawChecks(`${raw.stdout}\n${raw.stderr}`);
    if ((raw.exitCode ?? 0) === 0 || checks.length > 0 || /some checks were not successful/i.test(`${raw.stdout}\n${raw.stderr}`)) {
      routes.add("raw-gh");
      return { value: checks, route: "raw-gh" };
    }
    return undefined;
  }

  private async remoteHead(remote: string, branch: string, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics): Promise<string | undefined> {
    const result = await this.gitCommand(["ls-remote", "--heads", remote, `refs/heads/${branch}`], cwd, context, metrics);
    const line = result.stdout.trim().split("\n")[0] ?? "";
    return line.split(/\s+/)[0] || undefined;
  }

  private async findPullRequest(repository: GitHubRepository, branch: string, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>, options: PullRequestLookupOptions = {}): Promise<Attempt<GitHubPullRequest> | undefined> {
    const head = `${repository.owner}:${branch}`;
    // Older gh versions accepted only a bare branch for --head. Prefer the
    // owner-qualified form so a same-named fork cannot be selected, but keep a
    // compatibility retry when the installed CLI rejects that filter.
    let structured = await this.jsonCommand(["pr", "list", "--head", head, "--state", "all", "--json", PR_LOOKUP_JSON_FIELDS], cwd, context, metrics);
    if (structured === undefined) {
      structured = await this.jsonCommand(["pr", "list", "--head", branch, "--state", "all", "--json", PR_JSON_FIELDS], cwd, context, metrics);
    }
    if (structured !== undefined) {
      const value = selectPullRequest(parsePullRequests(structured.value), branch, repository);
      if (value !== undefined) {
        routes.add("gh-json");
        return { value, route: "gh-json" };
      }
      // A valid structured empty list is authoritative: there is no PR to
      // reconcile, so do not perform lower-priority reads or raw fallbacks.
      if (Array.isArray(structured.value) && options.reconcileAfterEmpty !== true) return undefined;
    }
    const api = await this.apiJson(`repos/${repositoryPath(repository)}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=100`, [], cwd, context, metrics);
    if (api !== undefined) {
      const value = selectPullRequest(parsePullRequests(api.value), branch, repository);
      if (value !== undefined) {
        routes.add(api.route);
        return { value, route: api.route };
      }
    }
    let raw = await this.rawJson(["pr", "list", "--head", head, "--state", "all", "--json", PR_LOOKUP_JSON_FIELDS], cwd, context, metrics);
    if (raw === undefined) {
      raw = await this.rawJson(["pr", "list", "--head", branch, "--state", "all", "--json", PR_JSON_FIELDS], cwd, context, metrics);
    }
    if (raw !== undefined) {
      const value = selectPullRequest(parsePullRequests(raw.value), branch, repository);
      if (value !== undefined) {
        routes.add("raw-gh");
        return { value, route: "raw-gh" };
      }
    }
    return undefined;
  }

  private async createPullRequest(repository: GitHubRepository, branch: string, base: string, title: string, body: string, cwd: string | undefined, context: OperationContext, metrics: ProviderMetrics, routes: Set<GitHubProviderRoute>): Promise<CreatePullRequestResult> {
    const api = await this.apiJson(`repos/${repositoryPath(repository)}/pulls`, ["--method", "POST", "--field", `title=${title}`, "--field", `head=${branch}`, "--field", `base=${base}`, "--field", `body=${body}`], cwd, context, metrics, false);
    const createdPullRequest = api === undefined ? undefined : parsePullRequest(api.value);
    if (createdPullRequest !== undefined) {
      if (api !== undefined) routes.add(api.route);
      return { created: true, pullRequest: createdPullRequest };
    }
    const reconciled = await this.findPullRequest(repository, branch, cwd, context, metrics, routes, { reconcileAfterEmpty: true });
    if (reconciled !== undefined) return { created: false, pullRequest: reconciled.value, effectState: "unknown" };
    // The API create was an effectful attempt. An empty or stale read after
    // that attempt is ambiguous, so a raw `gh pr create` retry could create a
    // duplicate PR. Leave raw shell available as the direct escape hatch and
    // require the caller to reconcile this operation before retrying.
    throw createRuntimeError({ code: "GITHUB_PR_CREATE_UNKNOWN", message: "Pull request creation was ambiguous and no existing pull request could be reconciled", retryable: true, effect: "unknown", details: { branch, base } });
  }
}

function selectPullRequest(values: readonly GitHubPullRequest[], branch: string, repository: GitHubRepository): GitHubPullRequest | undefined {
  const candidates = values.filter((value) => value.headRefName === branch && headBelongsToRepository(value, repository));
  return candidates.find((value) => (value.state ?? "").toLowerCase() !== "closed") ?? candidates[0];
}

function headBelongsToRepository(pullRequest: GitHubPullRequest, repository: GitHubRepository): boolean {
  if (pullRequest.headRepositoryNameWithOwner !== undefined) {
    return pullRequest.headRepositoryNameWithOwner.toLowerCase() === repository.nameWithOwner.toLowerCase();
  }
  return pullRequest.headRepositoryOwner === undefined || pullRequest.headRepositoryOwner.toLowerCase() === repository.owner.toLowerCase();
}

function parsePullRequestNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value.replace(/.*\/(\d+)$/, "$1"));
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function contextDeadline(context: OperationContext): number {
  return context.deadline === undefined ? Number.POSITIVE_INFINITY : context.deadline;
}

function withDeadline(context: OperationContext, deadline: number): OperationContext {
  if (!Number.isFinite(deadline) || context.deadline === deadline) return context;
  return createOperationContext({ ...context, deadline });
}

function routeList(routes: Set<GitHubProviderRoute>, includeRaw: boolean): GitHubProviderRoute[] {
  const priority: readonly GitHubProviderRoute[] = ["gh-json", "gh-api", "raw-gh", "unavailable"];
  const result = priority.filter((route) => routes.has(route));
  if (includeRaw && routes.size > 0 && !result.includes("raw-gh")) result.push("raw-gh");
  return result;
}

function unavailableCapabilities(error: string): GitHubCapabilities {
  return {
    available: false,
    ghAvailable: false,
    authenticated: false,
    structuredJson: false,
    api: false,
    rawGh: false,
    routes: ["unavailable"],
    error,
  };
}

function defaultContext(): OperationContext {
  return createOperationContext({ traceId: createTraceId(), runId: createRunId(), actor: "model" });
}

export const GitHubSnapshotProvider = GitHubProvider;
