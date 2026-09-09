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
    .when(["api", "repos/miki-thecat/runtime/issues/7/dependencies/blocked_by"], json([{ number: 5 }]))
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
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "feature/semantic\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "abc123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "origin", "refs/heads/feature/semantic"], { stdout: "abc123\trefs/heads/feature/semantic\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", "feature/semantic", "--state", "all", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json([{ number: 7, title: "semantic layer", state: "OPEN", headRefName: "feature/semantic", headRefOid: "abc123", baseRefName: "main" }]))
    .when(["pr", "view", "7", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 7, title: "semantic layer", state: "OPEN", headRefName: "feature/semantic", headRefOid: "abc123", baseRefName: "main" }));
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
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "feature/new\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "fedcba\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "origin", "refs/heads/feature/new"], { stdout: "fedcba\trefs/heads/feature/new\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", "feature/new", "--state", "all", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json([]))
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--field", "title=new PR", "--field", "head=feature/new", "--field", "base=main", "--field", "body=body"], json({ number: 11, title: "new PR", state: "OPEN", head: { ref: "feature/new", sha: "fedcba" }, base: { ref: "main" } }))
    .when(["pr", "view", "11", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 11, title: "new PR", state: "OPEN", headRefName: "feature/new", headRefOid: "fedcba", baseRefName: "main" }));
  const provider = new GitHubProvider({ runner });
  const result = await provider.publish({ title: "new PR", body: "body" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.created, true);
  assert.equal(result.data.pullRequest.number, 11);
  assert.equal(runner.executableCalls.some((call) => call[0] === "gh" && call[1] === "api"), true);
  assert.equal(runner.shellCalls.length, 0);
});

test("github.publish reconciles an ambiguous push before reusing a PR", async () => {
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: "feature/ambiguous\n", stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "def456\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "origin", "refs/heads/feature/ambiguous"], [
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "def456\trefs/heads/feature/ambiguous\n", stderr: "", exitCode: 0 },
      { stdout: "def456\trefs/heads/feature/ambiguous\n", stderr: "", exitCode: 0 },
    ])
    .when(["push", "origin", "HEAD:refs/heads/feature/ambiguous"], { stdout: "", stderr: "transport closed", exitCode: 1 })
    .when(["pr", "list", "--head", "feature/ambiguous", "--state", "all", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json([{ number: 9, state: "OPEN", headRefName: "feature/ambiguous", headRefOid: "def456", baseRefName: "main" }]))
    .when(["pr", "view", "9", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 9, state: "OPEN", headRefName: "feature/ambiguous", headRefOid: "def456", baseRefName: "main" }));
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
        { login: "inactive", active: false, state: "authenticated" },
        { login: "current", active: true, state: "authenticated" },
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
    baseRefName: "main",
  };
  const listArgs = ["pr", "list", "--head", branch, "--state", "all", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"];
  const freshArgs = ["pr", "view", "12", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"];
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "fed123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { stdout: "fed123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(listArgs, [json([]), json([])])
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--field", "title=ambiguous", "--field", `head=${branch}`, "--field", "base=main", "--field", "body="], { stdout: "", stderr: "transport closed", exitCode: 1 })
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
  const listArgs = ["pr", "list", "--head", branch, "--state", "all", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"];
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "stale123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { stdout: "stale123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(listArgs, json([{ number: 13, state: "OPEN", headRefName: branch, headRefOid: "stale123", baseRefName: "main" }]));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "stale" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "GITHUB_PR_FRESH_READ_FAILED");
});

test("github.publish preserves applied effect when post-push reconciliation cannot be read", async () => {
  const branch = "feature/post-push-read";
  const runner = new FixtureRunner()
    .when(["repo", "view", "--json", "name,nameWithOwner,url,defaultBranchRef,owner"], json(repo))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "applied123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], [
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
    .when(["remote", "get-url", "origin"], { stdout: "git@github.com:miki-thecat/runtime.git\n", stderr: "", exitCode: 0 })
    .when(["api", "repos/miki-thecat/runtime"], json({ name: "runtime", full_name: "miki-thecat/runtime", html_url: "https://github.com/miki-thecat/runtime", default_branch: "develop", owner: { login: "miki-thecat" } }))
    .when(["symbolic-ref", "--quiet", "--short", "HEAD"], { stdout: `${branch}\n`, stderr: "", exitCode: 0 })
    .when(["rev-parse", "HEAD"], { stdout: "rest123\n", stderr: "", exitCode: 0 })
    .when(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { stdout: "rest123\trefs/heads/" + branch + "\n", stderr: "", exitCode: 0 })
    .when(["pr", "list", "--head", branch, "--state", "all", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json([]))
    .when(["api", "repos/miki-thecat/runtime/pulls", "--method", "POST", "--field", "title=REST branch", "--field", `head=${branch}`, "--field", "base=develop", "--field", "body="], json({ number: 21, title: "REST branch", state: "OPEN", head: { ref: branch, sha: "rest123" }, base: { ref: "develop" } }))
    .when(["pr", "view", "21", "--json", "number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup,reviewDecision,reviews"], json({ number: 21, title: "REST branch", state: "OPEN", headRefName: branch, headRefOid: "rest123", baseRefName: "develop" }));
  const provider = new GitHubProvider({ runner });

  const result = await provider.publish({ branch, title: "REST branch" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.repository.defaultBranch, "develop");
  assert.equal(result.data.pullRequest.baseRefName, "develop");
  assert.equal(runner.executableCalls.some((args) => args.includes("base=develop")), true);
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
