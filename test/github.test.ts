import assert from "node:assert/strict";
import test from "node:test";
import { createOperationContext, createRunId, createTraceId } from "../src/core/index.ts";
import { InMemoryEventSink, Tracer } from "../src/observability/index.ts";
import { GitHubProvider, type GitHubCommandResult, type GitHubCommandRunner } from "../src/github/index.ts";

type Fixture = GitHubCommandResult | (() => GitHubCommandResult);

class FixtureRunner implements GitHubCommandRunner {
  readonly executableCalls: string[][] = [];
  readonly shellCalls: string[] = [];
  readonly shellInputs: Array<{ readonly command: string; readonly timeoutMs?: number }> = [];
  private readonly fixtures = new Map<string, Fixture | Fixture[]>();
  private readonly shellFixtures = new Map<string, Fixture | Fixture[]>();

  when(args: readonly string[], fixture: Fixture | readonly Fixture[]): this {
    this.fixtures.set(JSON.stringify(args), Array.isArray(fixture) ? [...fixture] : fixture);
    return this;
  }

  whenShell(command: string, fixture: Fixture | readonly Fixture[]): this {
    this.shellFixtures.set(command, Array.isArray(fixture) ? [...fixture] : fixture);
    return this;
  }

  async runExecutable(command: { readonly executable: string; readonly args?: readonly string[] }): Promise<GitHubCommandResult> {
    const args = [command.executable, ...(command.args ?? [])];
    this.executableCalls.push(args);
    return this.consume(args);
  }

  async runShell(input: { readonly command: string; readonly timeoutMs?: number }): Promise<GitHubCommandResult> {
    this.shellCalls.push(input.command);
    this.shellInputs.push(input.timeoutMs === undefined ? { command: input.command } : { command: input.command, timeoutMs: input.timeoutMs });
    const fixture = this.shellFixtures.get(input.command);
    if (fixture !== undefined) {
      if (Array.isArray(fixture)) {
        const next = fixture.shift();
        return next === undefined ? { stdout: "", stderr: "fixture exhausted", exitCode: 1 } : typeof next === "function" ? next() : next;
      }
      return typeof fixture === "function" ? fixture() : fixture;
    }
    return { stdout: "", stderr: "fixture shell miss", exitCode: 1 };
  }

  private consume(args: readonly string[]): GitHubCommandResult {
    const fixture = this.fixtures.get(JSON.stringify(args.slice(1)));
    if (fixture === undefined) return { stdout: "", stderr: `fixture miss: ${args.join(" ")}`, exitCode: 1 };
    if (Array.isArray(fixture)) {
      const next = fixture.shift();
      return next === undefined ? { stdout: "", stderr: "fixture exhausted", exitCode: 1 } : typeof next === "function" ? next() : next;
    }
    return typeof fixture === "function" ? fixture() : fixture;
  }
}

function json(value: unknown, extra: Partial<GitHubCommandResult> = {}): GitHubCommandResult {
  const stdout = JSON.stringify(value);
  return { stdout, stderr: "", exitCode: 0, rawOutputBytes: stdout.length * 2, returnedOutputBytes: stdout.length, ...extra };
}

function context(tracer: Tracer) {
  const run = tracer.startRun({ actor: "model" });
  return { run, context: createOperationContext({ traceId: run.traceId, runId: run.runId, spanId: run.spanId, actor: "model" }) };
}

const repo = {
  name: "runtime",
  nameWithOwner: "miki-thecat/runtime",
  url: "https://github.com/miki-thecat/runtime",
  defaultBranchRef: { name: "main" },
  owner: { login: "miki-thecat" },
};
const prLookupFields = "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews,headRepositoryOwner,headRepository";

function originRepositoryFixtures(runner: FixtureRunner, repository = repo): FixtureRunner {
  return runner
    .when(["remote", "get-url", "--push", "origin"], { stdout: `git@github.com:${repository.nameWithOwner}.git\n`, stderr: "", exitCode: 0 })
    .when(["remote", "get-url", "origin"], { stdout: `git@github.com:${repository.nameWithOwner}.git\n`, stderr: "", exitCode: 0 })
    .when(["api", `repos/${repository.nameWithOwner}`], json(repository));
}

test("github capabilities report gh, authentication, and current repository", async () => {
  const runner = new FixtureRunner()
    .when(["--version"], { stdout: "gh version 2.60.0 (2025-01-01)\n", stderr: "", exitCode: 0 })
    .when(["auth", "status", "--json", "hosts"], json({ hosts: { "github.com": [{ login: "miki-thecat", active: true }] } }))
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo));
  const provider = new GitHubProvider({ runner });
  const result = await provider.capabilities();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.ghAvailable, true);
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.account, "miki-thecat");
  assert.equal(result.data.currentRepository?.nameWithOwner, "miki-thecat/runtime");
  assert.equal(result.data.structuredJson, true);
  assert.deepEqual(result.data.routes, ["gh-json", "raw-gh"]);
});

test("github.snapshot compresses repository, PR, checks, reviews, and native dependencies", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "view", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({
      number: 7,
      title: "semantic layer",
      state: "OPEN",
      headRefName: "feature/semantic",
      headRefOid: "abc123",
      baseRefName: "main",
      statusCheckRollup: [
        { name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "lint", status: "IN_PROGRESS" },
      ],
      reviewDecision: "REVIEW_REQUIRED",
      reviews: [{ author: { login: "reviewer" }, state: "APPROVED" }],
    }))
    .when(["issue", "view", "7", "--json", "number,title,state,url,labels,assignees"], json({ number: 7, title: "FA-05", state: "OPEN", labels: [{ name: "ready" }] }))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocked_by"], json([{ number: 5, state: "open" }]))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocking"], json([{ number: 8 }]))
    .when(["branch", "--show-current"], { stdout: "feature/semantic\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "abc123\n", stderr: "", exitCode: 0 });
  const sink = new InMemoryEventSink();
  const tracer = new Tracer({ sink });
  const provider = new GitHubProvider({ runner, tracer });
  const { run, context: operationContext } = context(tracer);

  const result = await provider.snapshot({ issueNumber: 7, includeWork: true, issueNumbers: [7] }, operationContext);
  run.complete();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.repository?.nameWithOwner, "miki-thecat/runtime");
  assert.equal(result.data.currentPullRequest?.checksSummary.pending, 1);
  assert.deepEqual(result.data.dependencies, { issue: 7, blockedBy: [5], blocking: [8] });
  assert.deepEqual(result.data.work?.blocked, [7]);
  assert.equal(result.meta.metrics.pollCountModel, 0);
  assert.ok(result.meta.metrics.internalCalls >= 6);
  assert.ok(result.meta.metrics.rawOutputBytes > result.meta.metrics.returnedOutputBytes);
  assert.ok(result.meta.metrics.compressionRatio > 1);
  assert.equal(sink.events.some((event) => event.operation === "github.snapshot" && event.type === "operation.completed"), true);
});

test("github.wait polls internally and exposes zero model polls", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], [
      json([{ name: "verify", state: "IN_PROGRESS" }]),
      json([{ name: "verify", state: "COMPLETED", conclusion: "SUCCESS" }]),
    ]);
  const tracer = new Tracer();
  const provider = new GitHubProvider({ runner, tracer, sleep: async () => undefined });
  const { run, context: operationContext } = context(tracer);

  const result = await provider.wait({ pullRequest: 7, intervalMs: 0, maxPolls: 3 }, operationContext);
  run.complete();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.terminal, true);
  assert.equal(result.data.passed, true);
  assert.equal(result.data.pollCountInternal, 2);
  assert.equal(result.data.pollCountModel, 0);
  assert.equal(result.meta.metrics.pollCountInternal, 2);
  assert.equal(result.meta.metrics.pollCountModel, 0);
});

test("github.publish reuses an already reconciled PR without pushing or creating", async () => {
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "feature/semantic\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "abc123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", "refs/heads/feature/semantic"], { stdout: "abc123\trefs/heads/feature/semantic\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", "feature/semantic", "--state", "all", "--repo", "miki-thecat/runtime", "--json", prLookupFields], json([{ number: 7, title: "semantic layer", state: "OPEN", headRefName: "feature/semantic", headRefOid: "abc123", headRepository: { nameWithOwner: "miki-thecat/runtime" }, baseRefName: "main" }]))
    .when(["pr", "view", "7", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 7, title: "semantic layer", state: "OPEN", headRefName: "feature/semantic", headRefOid: "abc123", baseRefName: "main" }));
  const provider = new GitHubProvider({ runner });
  const result = await provider.publish({ title: "ignored on reuse" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.created, false);
  assert.equal(result.data.reused, true);
  assert.equal(result.data.pushed, false);
  assert.equal(result.data.reconciled, true);
  assert.equal(runner.executableCalls.some((call) => call[0] === "git" && call[1] === "push"), false);
  assert.equal(runner.shellCalls.length, 0);
});

test("github.publish creates through the API only after confirming no PR exists", async () => {
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "feature/new\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "fedcba\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", "refs/heads/feature/new"], { stdout: "fedcba\trefs/heads/feature/new\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", "feature/new", "--state", "all", "--repo", "miki-thecat/runtime", "--json", prLookupFields], json([]))
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--raw-field", "title=new PR", "--raw-field", "head=feature/new", "--raw-field", "base=main", "--raw-field", "body=body"], json({ number: 11, title: "new PR", state: "OPEN", head: { ref: "feature/new", sha: "fedcba" }, base: { ref: "main" } }))
    .when(["pr", "view", "11", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 11, title: "new PR", state: "OPEN", headRefName: "feature/new", headRefOid: "fedcba", baseRefName: "main" }));
  const provider = new GitHubProvider({ runner });
  const result = await provider.publish({ title: "new PR", body: "body" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.created, true);
  assert.equal(result.data.pullRequest.number, 11);
  assert.equal(runner.executableCalls.some((call) => call[0] === "gh" && call[1] === "api"), true);
  assert.equal(runner.shellCalls.length, 0);
});

test("github.publish follows an explicitly selected remote and preserves literal PR fields", async () => {
  const branch = "feature/selected-remote";
  const remoteRepository = {
    name: "target",
    full_name: "other-owner/target",
    html_url: "https://github.com/other-owner/target",
    default_branch: "develop",
    owner: { login: "other-owner" },
  };
  const lookupFields = "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews,headRepositoryOwner,headRepository";
  const freshFields = "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews";
  const runner = new FixtureRunner()
    .when(["remote", "get-url", "--push", "upstream"], { stdout: "git@github.com:other-owner/target.git\n", stderr: "", exitCode: 0 })
    .when(["remote", "get-url", "upstream"], { stdout: "git@github.com:other-owner/target.git\n", stderr: "", exitCode: 0 })
    .when(["api", "repos/other-owner/target"], json(remoteRepository))
    .when(["rev-parse", "HEAD"], { stdout: "selected123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:other-owner/target.git", `refs/heads/${branch}`], { stdout: "selected123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", "other-owner:" + branch, "--state", "all", "--repo", "other-owner/target", "--json", lookupFields], json([]))
    .when(["api", "repos/other-owner/target/pulls", "--method", "POST", "--raw-field", "title=123", "--raw-field", `head=${branch}`, "--raw-field", "base=develop", "--raw-field", "body=@body-is-literal"], json({ number: 31, title: "123", state: "OPEN", head: { ref: branch, sha: "selected123" }, base: { ref: "develop" } }))
    .when(["pr", "view", "31", "--repo", "other-owner/target", "--json", freshFields], json({ number: 31, title: "123", state: "OPEN", headRefName: branch, headRefOid: "selected123", baseRefName: "develop" }));
  const tracer = new Tracer();
  const provider = new GitHubProvider({ runner, tracer });

  const result = await provider.publish({ remote: "upstream", branch, title: "123", body: "@body-is-literal" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.repository.nameWithOwner, "other-owner/target");
  assert.equal(result.data.pullRequest.number, 31);
  assert.equal(result.data.created, true);
  assert.equal(provider.direct.tracer, tracer);
  assert.equal(runner.executableCalls.some((call) => call[0] === "gh" && call[1] === "repo"), false);
});

test("github.publish reconciles an ambiguous push before reusing a PR", async () => {
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "feature/ambiguous\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "def456\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", "refs/heads/feature/ambiguous"], [
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "def456\trefs/heads/feature/ambiguous\n", stderr: "", exitCode: 0 },
      { stdout: "def456\trefs/heads/feature/ambiguous\n", stderr: "", exitCode: 0 },
    ])
    .when(["push", "origin", "HEAD:refs/heads/feature/ambiguous"], { stdout: "", stderr: "transport closed", exitCode: 1 })
    .when(["pr", "list", "--head", "feature/ambiguous", "--state", "all", "--repo", "miki-thecat/runtime", "--json", prLookupFields], json([{ number: 9, state: "OPEN", headRefName: "feature/ambiguous", headRefOid: "def456", headRepository: { nameWithOwner: "miki-thecat/runtime" }, baseRefName: "main" }]))
    .when(["pr", "view", "9", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 9, state: "OPEN", headRefName: "feature/ambiguous", headRefOid: "def456", baseRefName: "main" }));
  const provider = new GitHubProvider({ runner });
  const result = await provider.publish({ title: "ambiguous" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.pushed, true);
  assert.equal(result.data.reconciled, true);
  assert.equal(result.data.created, false);
  assert.equal(result.data.effectState, "applied");
  assert.equal(runner.executableCalls.filter((call) => call[0] === "git" && call[1] === "push").length, 1);
});

test("github.wait treats error, stale, cancel, and fail outcomes as terminal failures", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], json([
      { name: "error", state: "ERROR" },
      { name: "stale", state: "STALE" },
      { name: "cancel", state: "COMPLETED", bucket: "CANCEL" },
      { name: "fail", state: "COMPLETED", bucket: "FAIL" },
      { name: "pass", state: "COMPLETED", bucket: "PASS" },
    ]));
  const provider = new GitHubProvider({ runner, sleep: async () => undefined });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, maxPolls: 3 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.terminal, true);
  assert.equal(result.data.passed, false);
  assert.equal(result.data.checksSummary.failed, 4);
  assert.equal(result.data.pollCountInternal, 1);
});

test("github capabilities select the active authenticated host", async () => {
  const runner = new FixtureRunner()
    .when(["--version"], { stdout: "gh version 2.60.0\n", stderr: "", exitCode: 0 })
    .when(["auth", "status", "--json", "hosts"], json({ hosts: {
      "github.com": [
        { login: "inactive", active: false, state: "success" },
        { login: "current", active: true, state: "success" },
      ],
    } }))
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo));
  const provider = new GitHubProvider({ runner });

  const result = await provider.capabilities();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.account, "current");
});

test("github.publish never retries an ambiguous API create with raw gh create", async () => {
  const branch = "feature/ambiguous-pr";
  const pullRequest = {
    number: 12,
    state: "OPEN",
    headRefName: branch,
    headRefOid: "fed123",
    head: { repo: { full_name: "miki-thecat/runtime" } },
    baseRefName: "main",
  };
  const listArgs = ["pr", "list", "--head", branch, "--state", "all", "--repo", "miki-thecat/runtime", "--json", prLookupFields];
  const freshArgs = ["pr", "view", "12", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"];
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "fed123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", `refs/heads/${branch}`], { stdout: "fed123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(listArgs, [json([]), json([])])
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--raw-field", "title=ambiguous", "--raw-field", `head=${branch}`, "--raw-field", "base=main", "--raw-field", "body="], { stdout: "", stderr: "transport closed", exitCode: 1 })
    .when(["api", "repos/miki-thecat/runtime/pulls?head=miki-thecat%3Afeature%2Fambiguous-pr&state=all&per_page=100"], json([pullRequest]))
    .when(freshArgs, json(pullRequest));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "ambiguous" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.created, false);
  assert.equal(result.data.reused, true);
  assert.equal(result.data.effectState, "unknown");
  assert.equal(runner.shellCalls.some((command) => command.includes("pr' 'create")), false);
});

test("github.publish does not return a stale PR when the required fresh read fails", async () => {
  const branch = "feature/stale-pr";
  const listArgs = ["pr", "list", "--head", branch, "--state", "all", "--repo", "miki-thecat/runtime", "--json", prLookupFields];
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "stale123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", `refs/heads/${branch}`], { stdout: "stale123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(listArgs, json([{ number: 13, state: "OPEN", headRefName: branch, headRefOid: "stale123", headRepository: { nameWithOwner: "miki-thecat/runtime" }, baseRefName: "main" }]));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "stale" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "GITHUB_PR_FRESH_READ_FAILED");
});

test("github.publish preserves applied effect when post-push reconciliation cannot be read", async () => {
  const branch = "feature/post-push-read";
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "applied123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", `refs/heads/${branch}`], [
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "remote read failed", exitCode: 1 },
    ])
    .when(["push", "origin", `HEAD:refs/heads/${branch}`], { stdout: "", stderr: "", exitCode: 0 });
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "post-push" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.effect, "applied");
});

test("github.wait bounds the raw check fallback and parses tabular status", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["remote", "get-url", "origin"], { stdout: "", stderr: "not a git repository", exitCode: 1 })
    .whenShell("'gh' 'pr' 'checks' '7'", { stdout: "✓ build pass 2s https://github.com/miki-thecat/runtime/actions/runs/1\n", stderr: "", exitCode: 0 });
  const provider = new GitHubProvider({ runner });

  const result = await provider.wait({ pullRequest: 7, timeoutMs: 100, maxPolls: 1, intervalMs: 0 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.checks[0]?.name, "build");
  assert.equal(result.data.checks[0]?.status, "pass");
  assert.equal(result.data.checksSummary.state, "success");
  assert.equal(runner.shellCalls.includes("'gh' 'pr' 'checks' '7'"), true);
  assert.equal(runner.shellCalls.some((command) => command.includes("--watch")), false);
  assert.ok((runner.shellInputs[runner.shellInputs.length - 1]?.timeoutMs ?? 0) > 0);
});

test("github.publish preserves a REST repository default branch", async () => {
  const branch = "feature/rest-repository";
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["remote", "get-url", "--push", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["remote", "get-url", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["api", "repos/miki-thecat/runtime"], json({ name: "runtime", full_name: "miki-thecat/runtime", html_url: "https://github.com/miki-thecat/runtime", default_branch: "develop", owner: { login: "miki-thecat" } }))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "rest123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", `refs/heads/${branch}`], { stdout: "rest123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", "miki-thecat:" + branch, "--state", "all", "--repo", "miki-thecat/runtime", "--json", prLookupFields], json([]))
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--raw-field", "title=REST branch", "--raw-field", `head=${branch}`, "--raw-field", "base=develop", "--raw-field", "body="], json({ number: 21, title: "REST branch", state: "OPEN", head: { ref: branch, sha: "rest123" }, base: { ref: "develop" } }))
    .when(["pr", "view", "21", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 21, title: "REST branch", state: "OPEN", headRefName: branch, headRefOid: "rest123", baseRefName: "develop" }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "REST branch" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.repository.defaultBranch, "develop");
  assert.equal(result.data.pullRequest.baseRefName, "develop");
  assert.equal(runner.executableCalls.some((args) => args.includes("base=develop")), true);
});

test("github.publish does not reuse an identity-free PR from the bare-branch fallback", async () => {
  const branch = "feature/unverified-head";
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "unverified123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", `refs/heads/${branch}`], { stdout: "unverified123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    // The owner-qualified query is intentionally unavailable, exercising the
    // compatibility retry. Its bare-branch result has no source identity.
    .when(["pr", "list", "--head", branch, "--state", "all", "--repo", "miki-thecat/runtime", "--json", prLookupFields], json([{ number: 41, state: "OPEN", headRefName: branch, headRefOid: "unverified123", baseRefName: "main" }]))
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--raw-field", "title=local PR", "--raw-field", `head=${branch}`, "--raw-field", "base=main", "--raw-field", "body="], json({ number: 42, title: "local PR", state: "OPEN", head: { ref: branch, sha: "unverified123" }, base: { ref: "main" } }))
    .when(["pr", "view", "42", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 42, title: "local PR", state: "OPEN", headRefName: branch, headRefOid: "unverified123", baseRefName: "main" }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "local PR" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.created, true);
  assert.equal(result.data.pullRequest.number, 42);
  assert.equal(runner.executableCalls.some((args) => args[0] === "gh" && args[1] === "api" && args[2] === "repos/miki-thecat/runtime/pulls"), true);
});

test("github.publish requires an explicit base when the repository default is unverified", async () => {
  const repositoryWithoutDefault = {
    name: "runtime",
    nameWithOwner: "miki-thecat/runtime",
    url: "https://github.com/miki-thecat/runtime",
    owner: { login: "miki-thecat" },
  };
  const runner = originRepositoryFixtures(new FixtureRunner(), repositoryWithoutDefault)
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repositoryWithoutDefault))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "feature/no-default\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "no-default123\n", stderr: "", exitCode: 0 });
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch: "feature/no-default", title: "must not guess base" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "GITHUB_DEFAULT_BRANCH_UNAVAILABLE");
  assert.equal(runner.executableCalls.some((args) => args[0] === "git" && args[1] === "ls-remote"), false);
  assert.equal(runner.executableCalls.some((args) => args[0] === "git" && args[1] === "push"), false);
});

test("github.work marks incomplete native dependency reads as unknown", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["issue", "view", "7", "--json", "number,title,state,url,labels,assignees"], json({ number: 7, title: "FA-05", state: "OPEN", labels: [{ name: "ready" }] }))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocked_by"], { stdout: "", stderr: "dependency endpoint unavailable", exitCode: 1 })
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocking"], { stdout: "", stderr: "dependency endpoint unavailable", exitCode: 1 });
  const provider = new GitHubProvider({ runner });

  const result = await provider.work({ issueNumbers: [7] });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.items[0]?.status, "unknown");
  assert.deepEqual(result.data.ready, []);
  assert.equal(result.data.dependencies[0]?.state, "unknown");
});

test("github.work treats a closed predecessor as resolved", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["issue", "view", "7", "--json", "number,title,state,url,labels,assignees"], json({ number: 7, title: "FA-05", state: "OPEN", labels: [{ name: "ready" }] }))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocked_by"], json([{ number: 5, state: "CLOSED" }]))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocking"], json([]));
  const provider = new GitHubProvider({ runner });

  const result = await provider.work({ issueNumbers: [7] });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.items[0]?.status, "ready");
  assert.deepEqual(result.data.items[0]?.blockedBy, []);
  assert.deepEqual(result.data.dependencies[0]?.blockedBy, []);
  assert.deepEqual(result.data.ready, [7]);
  assert.deepEqual(result.data.blocked, []);
});

test("github.work retains an open predecessor alongside a closed predecessor", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["issue", "view", "7", "--json", "number,title,state,url,labels,assignees"], json({ number: 7, title: "FA-05", state: "OPEN", labels: [{ name: "ready" }] }))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocked_by"], json([{ number: 5, state: "CLOSED" }, { number: 6, state: "OPEN" }]))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocking"], json([]));
  const provider = new GitHubProvider({ runner });

  const result = await provider.work({ issueNumbers: [7] });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.items[0]?.status, "blocked");
  assert.deepEqual(result.data.items[0]?.blockedBy, [6]);
  assert.deepEqual(result.data.dependencies[0]?.blockedBy, [6]);
  assert.deepEqual(result.data.ready, []);
  assert.deepEqual(result.data.blocked, [7]);
});

test("github.snapshot enriches REST pull requests with reviews and check-runs", async () => {
  const branch = "feature/rest-state";
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["branch", "--show-current"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "rest-state-sha\n", stderr: "", exitCode: 0 })
    .when(["pr", "view", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["api", "repos/miki-thecat/runtime/pulls?head=miki-thecat%3Afeature%2Frest-state&state=open&per_page=1"], json([{ number: 7, state: "OPEN", head: { ref: branch, sha: "rest-state-sha", repo: { full_name: "miki-thecat/runtime" } }, base: { ref: "main" } }]))
    .when(["api", "repos/miki-thecat/runtime/pulls/7/reviews"], json([{ user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-09-09T00:00:00Z" }]))
    .when(["api", "repos/miki-thecat/runtime/commits/rest-state-sha/check-runs"], json({ check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.snapshot({}, createOperationContext({ traceId: createTraceId(), runId: createRunId(), actor: "model" }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.currentPullRequest?.checksSummary.state, "success");
  assert.equal(result.data.currentPullRequest?.checksSummary.passed, 1);
  assert.equal(result.data.currentPullRequest?.reviewsSummary.approved, 1);
  assert.equal(result.data.currentPullRequest?.reviews[0]?.author, "reviewer");
});

test("github.wait treats raw failure summaries as terminal and never as pending checks", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .whenShell("'gh' 'pr' 'checks' '7'", { stdout: "X build fail 1s https://github.com/miki-thecat/runtime/actions/runs/1\n", stderr: "Some checks were not successful\n", exitCode: 1 });
  const provider = new GitHubProvider({ runner });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", timeoutMs: 100, maxPolls: 1, intervalMs: 0 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.terminal, true);
  assert.equal(result.data.passed, false);
  assert.equal(result.data.checksSummary.failed, 1);
  assert.equal(result.data.checks.some((check) => check.name.includes("Some checks")), false);
});

test("github.wait does not pass a neutral or empty check set", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], json([{ name: "skipped", state: "COMPLETED", bucket: "NEUTRAL" }]));
  const provider = new GitHubProvider({ runner });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", timeoutMs: 100, maxPolls: 1, intervalMs: 0 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.terminal, true);
  assert.equal(result.data.passed, false);
  assert.equal(result.data.checksSummary.state, "neutral");
  assert.equal(result.data.checksSummary.passed, 0);
});

test("github.publish ignores a same-named fork pull request", async () => {
  const branch = "feature/fork-name";
  const lookupFields = "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews,headRepositoryOwner,headRepository";
  const runner = originRepositoryFixtures(new FixtureRunner())
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "fork-local-sha\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", `refs/heads/${branch}`], { stdout: "fork-local-sha\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", "miki-thecat:" + branch, "--state", "all", "--repo", "miki-thecat/runtime", "--json", lookupFields], json([{ number: 4, state: "OPEN", headRefName: branch, headRefOid: "fork-local-sha", headRepositoryOwner: { login: "someone-else" }, headRepository: { nameWithOwner: "someone-else/runtime" }, baseRefName: "main" }]))
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--raw-field", "title=local PR", "--raw-field", `head=${branch}`, "--raw-field", "base=main", "--raw-field", "body="], json({ number: 5, title: "local PR", state: "OPEN", head: { ref: branch, sha: "fork-local-sha" }, base: { ref: "main" } }))
    .when(["pr", "view", "5", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 5, title: "local PR", state: "OPEN", headRefName: branch, headRefOid: "fork-local-sha", baseRefName: "main" }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "local PR" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.created, true);
  assert.equal(result.data.pullRequest.number, 5);
});

test("github.work recognizes the canonical agent:running lifecycle label", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["issue", "view", "7", "--json", "number,title,state,url,labels,assignees"], json({ number: 7, title: "FA-05", state: "OPEN", labels: [{ name: "agent:running" }] }))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocked_by"], json([]))
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocking"], json([]));
  const provider = new GitHubProvider({ runner });

  const result = await provider.work({ issueNumbers: [7] });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.inProgress, [7]);
  assert.deepEqual(result.data.ready, []);
});

test("github REST enrichment paginates reviews and merges check runs with legacy statuses", async () => {
  const branch = "feature/rest-paginated";
  const reviews = [
    { user: { login: "same-reviewer" }, state: "APPROVED", submitted_at: "2026-09-09T00:00:00Z" },
    { user: { login: "same-reviewer" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-09T01:00:00Z" },
    ...Array.from({ length: 30 }, (_, index) => ({ user: { login: `reviewer-${index}` }, state: "APPROVED", submitted_at: `2026-09-08T${String(index % 24).padStart(2, "0")}:00:00Z` })),
  ];
  const checkRuns = Array.from({ length: 31 }, (_, index) => ({ name: `check-${index}`, status: "completed", conclusion: "success" }));
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["remote", "get-url", "--push", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["remote", "get-url", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["api", "repos/miki-thecat/runtime"], json({ name: "runtime", full_name: "miki-thecat/runtime", default_branch: "main", owner: { login: "miki-thecat" } }))
    .when(["branch", "--show-current"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "rest-paginated-sha\n", stderr: "", exitCode: 0 })
    .when(["pr", "view", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["api", "repos/miki-thecat/runtime/pulls?head=miki-thecat%3Afeature%2Frest-paginated&state=open&per_page=1"], json([{ number: 7, state: "OPEN", head: { ref: branch, sha: "rest-paginated-sha", repo: { full_name: "miki-thecat/runtime" } }, base: { ref: "main" } }]))
    .when(["api", "repos/miki-thecat/runtime/pulls/7/reviews?per_page=100", "--paginate", "--slurp"], json(reviews))
    .when(["api", "repos/miki-thecat/runtime/commits/rest-paginated-sha/check-runs?per_page=100", "--paginate", "--slurp"], json({ check_runs: checkRuns }))
    .when(["api", "repos/miki-thecat/runtime/commits/rest-paginated-sha/status?per_page=100", "--paginate", "--slurp"], json({ statuses: [{ context: "legacy", state: "failure" }] }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.snapshot({}, createOperationContext({ traceId: createTraceId(), runId: createRunId(), actor: "model" }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const pullRequest = result.data.currentPullRequest;
  assert.equal(pullRequest?.reviews.length, 32);
  assert.equal(pullRequest?.reviewsSummary.approved, 30);
  assert.equal(pullRequest?.reviewsSummary.changesRequested, 1);
  assert.equal(pullRequest?.checks.length, 32);
  assert.equal(pullRequest?.checksSummary.failed, 1);
  assert.equal(pullRequest?.checksSummary.pending, 0);
  assert.equal(pullRequest?.checksSummary.state, "failure");
});

test("github REST review summaries stay incomplete when the effective row has no valid timestamp", async () => {
  const branch = "feature/review-timestamp-unknown";
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["remote", "get-url", "--push", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["remote", "get-url", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["api", "repos/miki-thecat/runtime"], json(repo))
    .when(["branch", "--show-current"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "review-timestamp-sha\n", stderr: "", exitCode: 0 })
    .when(["pr", "view", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["api", "repos/miki-thecat/runtime/pulls?head=miki-thecat%3Afeature%2Freview-timestamp-unknown&state=open&per_page=1"], json([{ number: 7, state: "OPEN", head: { ref: branch, sha: "review-timestamp-sha", repo: { full_name: "miki-thecat/runtime" } }, base: { ref: "main" } }]))
    .when(["api", "repos/miki-thecat/runtime/pulls/7/reviews?per_page=100", "--paginate", "--slurp"], json([
      { user: { login: "same-reviewer" }, state: "APPROVED", submitted_at: "2026-09-09T00:00:00Z" },
      { user: { login: "same-reviewer" }, state: "CHANGES_REQUESTED", submitted_at: "not-a-timestamp" },
    ]))
    .when(["api", "repos/miki-thecat/runtime/commits/review-timestamp-sha/check-runs?per_page=100", "--paginate", "--slurp"], json({ check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] }))
    .when(["api", "repos/miki-thecat/runtime/commits/review-timestamp-sha/status?per_page=100", "--paginate", "--slurp"], json({ statuses: [] }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.snapshot({}, createOperationContext({ traceId: createTraceId(), runId: createRunId(), actor: "model" }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.currentPullRequest?.reviewsSummary.approved, 0);
  assert.equal(result.data.currentPullRequest?.reviewsSummary.changesRequested, 1);
  assert.equal(result.data.currentPullRequest?.reviewsSummary.complete, false);
});

test("github.wait keeps a legacy failing status from passing successful check runs", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], { stdout: "", stderr: "unsupported", exitCode: 1 })
    .when(["api", "repos/miki-thecat/runtime/pulls/7"], json({ head: { sha: "status-sha" } }))
    .when(["api", "repos/miki-thecat/runtime/commits/status-sha/check-runs?per_page=100", "--paginate", "--slurp"], json({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }))
    .when(["api", "repos/miki-thecat/runtime/commits/status-sha/status?per_page=100", "--paginate", "--slurp"], json({ statuses: [{ context: "legacy", state: "failure" }] }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, timeoutMs: 100, maxPolls: 1 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.terminal, true);
  assert.equal(result.data.passed, false);
  assert.equal(result.data.checksSummary.failed, 1);
});

test("github.wait uses its default deadline instead of an implicit 120-poll cap", async () => {
  let now = 0;
  const tracer = new Tracer({ clock: () => new Date(now) });
  const pending = Array.from({ length: 121 }, () => json([{ name: "verify", state: "IN_PROGRESS" }]));
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], [...pending, json([{ name: "verify", state: "COMPLETED", conclusion: "SUCCESS" }])]);
  const provider = new GitHubProvider({ runner, tracer, clock: () => now, sleep: async (milliseconds) => { now += milliseconds; } });

  const result = await provider.wait({ pullRequest: 7 }, createOperationContext({ traceId: createTraceId(), runId: createRunId(), actor: "model" }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.pollCountInternal, 122);
  assert.equal(result.data.passed, true);
});

test("github.publish scopes default-remote PR reconciliation to origin", async () => {
  const branch = "feature/default-origin";
  const repositoryA = { ...repo, nameWithOwner: "other-owner/checkout" };
  const repositoryB = { ...repo, defaultBranchRef: { name: "main" } };
  const runner = new FixtureRunner()
    .when(["remote", "get-url", "--push", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["remote", "get-url", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["api", "repos/miki-thecat/runtime"], json(repositoryB))
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repositoryA))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "origin-sha\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "git@github.com:miki-thecat/runtime.git", `refs/heads/${branch}`], { stdout: "origin-sha\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--raw-field", "title=origin", "--raw-field", `head=${branch}`, "--raw-field", "base=main", "--raw-field", "body="], json({ number: 52, state: "OPEN", head: { ref: branch, sha: "origin-sha" }, base: { ref: "main" } }))
    .when(["pr", "view", "52", "--repo", "miki-thecat/runtime", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 52, state: "OPEN", headRefName: branch, headRefOid: "origin-sha", baseRefName: "main" }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "origin" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.repository.nameWithOwner, "miki-thecat/runtime");
  assert.equal(result.data.pullRequest.number, 52);
  assert.equal(runner.executableCalls.some((args) => args[0] === "gh" && args[1] === "pr" && args.includes("--repo") && args[args.indexOf("--repo") + 1] === "other-owner/checkout"), false);
  assert.equal(runner.executableCalls.some((args) => args[0] === "gh" && args[1] === "pr" && args.includes("--repo") && args[args.indexOf("--repo") + 1] === "miki-thecat/runtime"), true);
});

test("github.publish does not fall back to an unscoped repository when origin is unreadable", async () => {
  const repositoryA = { ...repo, nameWithOwner: "other-owner/checkout" };
  const runner = new FixtureRunner()
    .when(["remote", "get-url", "--push", "origin"], { stdout: "", stderr: "origin unavailable", exitCode: 1 })
    .when(["remote", "get-url", "origin"], { stdout: "git@github.com:other-owner/checkout.git\n", stderr: "", exitCode: 0 })
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repositoryA));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch: "feature/unreadable-origin", title: "must not target A" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "GITHUB_REPOSITORY_NOT_FOUND");
  assert.equal(runner.executableCalls.some((args) => args[0] === "gh" && args[1] === "repo"), false);
  assert.equal(runner.executableCalls.some((args) => args[0] === "git" && args[1] === "remote" && args[2] === "get-url" && args[3] === "origin"), false);
  assert.equal(runner.executableCalls.some((args) => args[0] === "git" && args[1] === "push"), false);
});

test("github reads retry a rate-limited API call after bounded backoff without shell duplication", async () => {
  const delays: number[] = [];
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], [
      { stdout: "", stderr: "HTTP 429: rate limit exceeded\nRetry-After: 1\n", exitCode: 1, httpStatus: 429 },
      json([{ name: "verify", state: "COMPLETED", conclusion: "SUCCESS" }]),
    ]);
  const provider = new GitHubProvider({ runner, sleep: async (milliseconds) => { delays.push(milliseconds); } });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, timeoutMs: 5_000, maxPolls: 1 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.passed, true);
  assert.deepEqual(delays, [1_000]);
  assert.equal(runner.shellCalls.length, 0);
  assert.equal(result.meta.metrics.retries, 1);
});

test("github rate-limit hints beyond the bound terminate without an early duplicate", async () => {
  const delays: number[] = [];
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], { stdout: "", stderr: "HTTP 429: secondary rate limit\n", exitCode: 1, httpStatus: 429, headers: { "retry-after": "3600" } });
  const provider = new GitHubProvider({ runner, sleep: async (milliseconds) => { delays.push(milliseconds); } });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, timeoutMs: 5_000, maxPolls: 1 });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "GITHUB_RATE_LIMITED");
  assert.deepEqual(delays, []);
  assert.equal(runner.executableCalls.filter((args) => args[0] === "gh" && args[1] === "pr" && args[2] === "checks").length, 1);
  assert.equal(runner.shellCalls.length, 0);
  assert.equal(result.meta.metrics.retries, 0);
});

test("github secondary rate limits without a retry floor hint terminate without retry or shell duplication", async () => {
  const nowMs = Date.now();
  const delays: number[] = [];
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], {
      stdout: "",
      stderr: "HTTP 403\n",
      exitCode: 1,
      httpStatus: 403,
      headers: { "x-ratelimit-remaining": "42" },
    });
  const provider = new GitHubProvider({ runner, clock: () => nowMs, sleep: async (milliseconds) => { delays.push(milliseconds); } });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, timeoutMs: 5_000, maxPolls: 1 });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "GITHUB_RATE_LIMITED");
  assert.deepEqual(delays, []);
  assert.equal(runner.executableCalls.filter((args) => args[0] === "gh" && args[1] === "pr" && args[2] === "checks").length, 1);
  assert.equal(runner.shellCalls.length, 0);
  assert.equal(result.meta.metrics.retries, 0);
});

test("github 429 without a retry hint is a terminal secondary limit", async () => {
  const delays: number[] = [];
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], {
      stdout: "",
      stderr: "HTTP 429: too many requests\n",
      exitCode: 1,
      httpStatus: 429,
    });
  const provider = new GitHubProvider({ runner, sleep: async (milliseconds) => { delays.push(milliseconds); } });

  const result = await provider.wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, timeoutMs: 5_000, maxPolls: 1 });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "GITHUB_RATE_LIMITED");
  assert.deepEqual(delays, []);
  assert.equal(runner.executableCalls.filter((args) => args[0] === "gh" && args[1] === "pr" && args[2] === "checks").length, 1);
  assert.equal(runner.shellCalls.length, 0);
  assert.equal(result.meta.metrics.retries, 0);
});

test("github rate-limit wording in successful or ordinary transient responses is not rate limiting", async () => {
  const successfulRunner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], json([{ name: "please wait", state: "COMPLETED", conclusion: "SUCCESS" }]));
  const successful = await new GitHubProvider({ runner: successfulRunner }).wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, timeoutMs: 100, maxPolls: 1 });
  assert.equal(successful.ok, true);
  if (!successful.ok) return;
  assert.equal(successful.data.passed, true);

  const ordinaryRunner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["pr", "checks", "7", "--json", "name,state,bucket,link"], { stdout: "", stderr: "HTTP 503: please wait\n", exitCode: 1, httpStatus: 503 })
    .when(["api", "repos/miki-thecat/runtime/pulls/7"], { stdout: "", stderr: "HTTP 403: forbidden\n", exitCode: 1, httpStatus: 403, headers: { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1_000) + 2) } });
  const ordinary = await new GitHubProvider({ runner: ordinaryRunner }).wait({ pullRequest: 7, condition: "checks_passed", intervalMs: 0, timeoutMs: 100, maxPolls: 1 });
  assert.equal(ordinary.ok, false);
  if (ordinary.ok) return;
  assert.notEqual(ordinary.error.code, "GITHUB_RATE_LIMITED");
});
