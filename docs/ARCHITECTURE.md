# AI Execution Runtime — Canonical Architecture

Status: **canonical for Product-complete Full Alpha**  
Date: 2026-09-09

## 1. Product definition

AI Execution Runtime (AER) is a persistent, local-first execution layer between AI clients and computers. It lets an AI operate a machine directly for small/inspectable work or delegate larger work to a specialized agent while preserving execution state, evidence, observability, rollback information, and compact model-facing results.

AER is not an LLM, planner, coding agent, terminal emulator, Git implementation, or cloud workflow product. Those are providers/backends. AER owns the execution contract around them.

Primary promise:

> One AI control surface can inspect a project, act on the computer, delegate when useful, wait without chat-level polling, verify outcomes, recover context across chats, and explain exactly what happened.

## 2. Non-negotiable invariants

1. **ChatGPT / the AI client is the brain.** AER v0 contains no second LLM planner or autonomous router.
2. **Direct and delegated execution are siblings.** Codex is never a mandatory hop between ChatGPT and the computer.
3. **The project owns durable state.** Chats and agent sessions are transient views over project-owned state.
4. **Every meaningful operation is observable.** Instrumentation is part of the operation contract, not an add-on.
5. **Model-facing output is bounded.** Large/raw output becomes a local artifact; the AI receives a compact structured result.
6. **Effects are explicit.** Writes, remote effects, destructive actions, approvals, and idempotency are represented in the runtime contract.
7. **Long waits are internal.** AER waits for processes/checks/agents; the model should not poll repeatedly.
8. **Semantic compression never removes the escape hatch.** High-level operations fall back to structured primitives, then raw CLI.
9. **Provider capabilities are detected, not assumed from versions.** Missing Docker/Codex/gh degrades capability rather than breaking the runtime.
10. **Surfaces are thin.** CLI, MCP, Apps SDK, and remote transport call the same internal operations.11. **Local-first privacy.** Execution history and artifacts stay local by default; sensitive content is opt-in.
12. **Breadth before hardening in Full Alpha.** The full product path exists before exhaustive edge-case testing or production polish.

## 3. Control and execution model

```text
Human
  |
  v
ChatGPT / AI client
  |  decides intent, executor, next action
  v
AER surfaces: MCP | CLI | local API
  |
  v
Runtime kernel
  |-- project/task state
  |-- operation registry
  |-- observability
  |-- policy/effects
  |-- artifacts
  |
  +----------------------+-----------------------+
  |                      |                       |
  v                      v                       v
DIRECT                 DELEGATE                REMOTE
shell/process/files    Codex/agent adapters    device runtime
search/git/github       |                       |
  |                      v                       v
  +-----------------> execution environment <---+
                         |
                  direct | sandbox | microVM
```

Preferred pattern: **ChatGPT direct inspect -> delegated implementation when useful -> ChatGPT/AER independent verification.**
## 4. Dependency direction

```text
surfaces (CLI/MCP/App)
        |
orchestration (project/task/device/agent)
        |
domain operations (direct/files/github/verify/change)
        |
core + state + observability + artifacts + policy
        |
Node/OS/gh/git/Codex/sbx/network providers
```

No provider imports an MCP/App-specific type. No product state is owned by Codex or an MCP session.

## 5. Semantic Compression Ladder

```text
AI intent
   |
   v
semantic operation
   |  project.inspect / github.snapshot / verify.run
   v
structured primitive
   |  file.read / process.run / git/GitHub provider
   v
raw escape hatch
      shell.run("gh ...") / shell.run("git ...") / arbitrary CLI
```

AER measures internal calls, raw bytes observed, bytes returned to the model, retries, polling, and duration. Abstraction must reduce model work without reducing ultimate capability.

## 6. Canonical module layout

Full Alpha remains one Node package; do not introduce a monorepo.
```text
src/
  core/             IDs, result/error/effect/capability contracts
  observability/    tracing, event schema, metrics, redaction
  state/            SQLite store, migrations, materialized state
  artifacts/        content-addressed local artifact store
  operations/       small operation interface + registry
  direct/           shell/process execution
  files/            read/search/patch primitives
  changes/          ChangeSet and rollback records
  project/          registry, inspect, resume, local Git snapshot
  tasks/            durable runtime task state
  verify/           project-defined verification
  github/           gh/API-backed semantic GitHub operations
  agents/           AgentExecutor contract + Codex implementation
  policy/           effect classes, budgets, approval decisions
  sandbox/          execution-environment provider abstraction
  remote/           device model, transport envelopes, dev relay
  server/           long-lived local runtime/daemon host
  mcp/              MCP adapter only
  cli/              CLI adapter only
  benchmark/        run comparison / dogfood scenarios
```

## 7. Core contracts

Every operation returns one envelope:

```ts
interface RuntimeResult<T> {
  ok: boolean;
  data?: T;
  error?: RuntimeError;
  meta: OperationMeta;
}
```
`OperationMeta` carries IDs, timing, artifacts, effect state, and compact observability counters. Transport-specific fields do not belong here.

Errors are machine-actionable:

```ts
interface RuntimeError {
  code: string;
  message: string;
  retryable: boolean;
  effect: 'none' | 'unknown' | 'applied';
  details?: Record<string, unknown>;
}
```

`effect: unknown` is critical for network/GitHub actions: an ambiguous response never causes a blind repeat of a potentially completed side effect.

Every `OperationContext` carries trace/run/task IDs, project/device identity, actor, deadline/cancellation signal, effect policy, and an idempotency key when meaningful.

Providers report capabilities such as `resume`, `streaming`, `approval`, `structured_output`, `sandbox`, `network_policy`, and `remote`. Consumers branch on capabilities, not provider versions.

## 8. Runtime state model

```text
QUEUED
  -> RUNNING
      -> WAITING_APPROVAL
      -> WAITING_USER
      -> BLOCKED
  -> VERIFYING
  -> COMPLETED

FAILED | CANCELLED | UNKNOWN
```

`UNKNOWN` is deliberate. After crashes or ambiguous remote effects, AER records uncertainty rather than inventing success/failure. A `run` groups one user-level job; durable `tasks` and operation/process/agent/verification spans belong under it.
## 9. Storage and artifacts

Canonical local state root:

```text
~/.aer/
  aer.db
  artifacts/
  runtime/
```

Project-owned configuration may live in a committed `.aer/project.json`; mutable runtime state stays outside the repository by default.

Minimum SQLite tables:

```text
schema_migrations  projects       decisions
runs               tasks          events
processes          agent_runs     verifications
changesets         changeset_files
artifacts           devices        effect_receipts
```

The event log is append-only; materialized tables make current-state queries cheap. Full Alpha uses built-in `node:sqlite` behind a `StateStore` interface so storage can be replaced later without changing domain operations.

Large output, full logs, diffs and optional snapshots become content-addressed local artifacts:

```text
artifact://sha256:<digest>
```

The model receives summaries plus references. Artifact reads are bounded and artifacts carry media type, size, origin and sensitivity metadata.

## 10. Observability

`docs/OBSERVABILITY.md` is mandatory for every operation. At minimum measure duration, status, internal/tool calls, retries, model/internal polling, raw/returned/artifact bytes, files read/changed, executor/provider, verification, and token usage when provided.
AER keeps an internal canonical schema and can export OpenTelemetry later; core storage is not coupled to evolving telemetry conventions.

## 11. Direct execution, files and ChangeSets

### Shell/process
- `shell.run` is the universal raw escape hatch.
- structured executable+args execution is preferred for internal operations.
- output is bounded; overflow becomes artifacts.
- process start/wait/cancel happens inside the runtime so the AI does not poll.
- timeout/cancellation is first-class.
- after daemon restart, unreattachable processes become `UNKNOWN`/`ORPHANED`, not silently `RUNNING`.

### Files/search
- confine semantic file operations to the project root and defend against path/symlink escape;
- bounded line/range reads return a content hash;
- use `rg --json` when available with deterministic fallback;
- patch/write uses precondition hashes and atomic replacement;
- never dump an entire large repository into model context.

### ChangeSet

```text
read/hash -> patch -> ChangeSet -> verify -> keep/rollback
```

Each modified file records before/after hashes and sufficient local evidence to reverse an AER-mediated patch. Full Alpha does not claim it can reverse arbitrary raw-shell side effects.

## 12. Project and verification

`project.inspect` returns a compact live snapshot: project identity, local Git branch/HEAD/dirty/divergence/diff summary, active tasks/processes, latest verification, provider capabilities, and optional GitHub summary.

`project.resume` returns a bounded new-chat context pack: goal/identity, active decisions, task/run, recent meaningful events, live Git state, last agent result, blockers/unknown effects, latest verification and artifacts. It does not duplicate source code or stale remote facts into memory.
Verification is configured, not invented by the agent. Example `.aer/project.json`:

```json
{
  "verify": ["pnpm typecheck", "pnpm test:smoke"]
}
```

`verify.run` uses the normal observable process layer and stores evidence. An agent saying "done" is never equivalent to verification success. Full Alpha intentionally keeps verification shallow.

## 13. Git and GitHub

Git is the local source of truth. GitHub is a remote provider. AER reimplements neither.

Provider priority:

```text
structured `gh --json`
    -> `gh api` REST/GraphQL
    -> raw `gh` through shell.run
```

Full Alpha delegates authentication to `gh auth`.

### `github.snapshot`
Compress repository/Issue/PR/check/review/dependency state into one AI-facing result. Several provider calls are acceptable internally; observability records internal calls and compression ratio.

### `github.wait`
Wait inside AER for conditions such as terminal PR checks. `gh pr checks --watch` or bounded API polling are provider details; the AI sees one wait operation.

### `github.publish`
1. inspect local branch/HEAD;
2. inspect remote branch;
3. push only if required;
4. fresh-read remote HEAD;
5. find matching existing PR;
6. create only if absent;
7. fresh-read exact PR/HEAD/base;
8. return an effect receipt.
Ambiguous network responses are reconciled by fresh reads, never blind retries. GitHub-native Issue dependencies remain the source of truth for development DAGs; AER may compress ready/running/blocked/candidate work without replacing GitHub.

## 14. Agent execution

```ts
interface AgentExecutor {
  capabilities(): Promise<AgentCapabilities>;
  run(task: AgentTask, context: OperationContext): Promise<AgentRun>;
  cancel(runId: string): Promise<void>;
}
```

Full Alpha implements Codex using structured `codex exec --json`: simple, observable and already available. The contract must permit later Codex App Server, ACP, Claude, OpenCode, Gemini, Hermes or PTY adapters without changing project/task ownership.

Agent terminal state, duration, usage/tool counts and artifacts enter AER observability. Full prompts/transcripts are not persisted by default.

## 15. Policy and execution environments

Operations declare effect classes:

```text
read
workspace_write
network
remote_write
destructive
privileged
```

Policy returns `allow`, `deny` or `approval_required`. Full Alpha supplies a small configurable policy/audit contract, not enterprise RBAC. Effectful operations accept idempotency keys where meaningful; semantic operations never silently promote privileged execution.

`SandboxProvider` is the execution-environment boundary. Full Alpha ships a working Direct provider plus Docker Sandbox capability detection/adapter boundary. If `sbx` is absent, capability is `unavailable` rather than a runtime failure.

Do not implement native Firecracker infrastructure in Full Alpha.
## 16. Remote device and daemon

A device runs an AER runtime and advertises capabilities. Remote execution sends semantic operation envelopes, not undocumented raw RPC.

Minimum remote envelope:

```text
request_id / trace_id / run_id
device_id / project_id
operation + validated input
deadline
effect class
idempotency key
response/effect receipt
```

Full Alpha implements a development transport and one-device/loopback E2E. Production account auth, billing, fleet governance and internet-relay hardening are later work.

AER also needs a long-lived local runtime host so processes, device presence and remote requests have an owner beyond one CLI invocation. CLI/MCP become clients/adapters to that host where persistence matters; an in-process path can remain for tests/simple commands.

For self-development, OpenAI Secure MCP Tunnel can expose a private/local MCP server without requiring AER to build a production relay first.

## 17. MCP and ChatGPT surface

Use the official MCP TypeScript SDK v2 and explicitly support the 2026-07-28 modern protocol. Do not use deprecated MCP Logging/Roots/Sampling as AER's internal architecture.

AER owns tasks internally. MCP task-extension support can be an adapter later; MCP wire state is not canonical project/task state.

Candidate compact operations exposed through MCP:

```text
project.inspect     project.resume
shell.run           process.manage
file.read           file.patch
search              verify.run
github.snapshot     github.wait     github.publish
agent.run           run.inspect
artifact.read       device.list
```

Do not expose dozens of backend-shaped microtools. Raw power remains available through `shell.run`.
Apps SDK packaging is a thin distribution/UI layer over the same MCP operations. Current ChatGPT plan restrictions are deployment/test constraints, not reasons to change runtime architecture.

## 18. CLI target

```text
aer doctor
aer init
aer inspect
aer resume
aer run <command>
aer process <start|wait|cancel>
aer verify
aer github snapshot
aer github wait
aer github publish
aer agent codex <task>
aer runs list
aer runs show <id>
aer runs compare <a> <b>
aer mcp
aer daemon
aer device list
```

Every automation-facing command has stable structured JSON output.

## 19. Full Alpha quality strategy

Today optimizes **product breadth, not testing depth**. Every subsystem needs one working happy path, contract/safety tests whose failure would invalidate the product path, observability, and bounded output/error behavior.

Defer exhaustive edge cases, cross-platform polish, performance tuning, deep unit matrices, production security hardening and provider breadth until the Full Alpha E2E is real.

## 20. Explicitly deferred

- production hosted relay/account system;
- billing/teams/RBAC;
- native Firecracker/gVisor/Kubernetes infrastructure;
- vector DB/GraphRAG;
- autonomous in-runtime LLM router/planner;
- full Claude/OpenCode/Hermes/Gemini adapters;
- advanced PTY fidelity;
- fancy dashboard/mobile client;
- enterprise secrets platform;
- exhaustive unit/compatibility/performance suites.
## 21. External specification baseline

Architecture checked on 2026-09-09 against:

- MCP TS SDK v2 / 2026-07-28: https://ts.sdk.modelcontextprotocol.io/v2/
- MCP 2026-07-28 changes: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- GitHub CLI PR JSON/checks: https://cli.github.com/manual/gh_pr_view and https://cli.github.com/manual/gh_pr_checks
- GitHub Issue dependencies: https://docs.github.com/en/rest/issues/issue-dependencies
- Docker Sandboxes: https://docs.docker.com/ai/sandboxes/
- OpenTelemetry semantic conventions: https://opentelemetry.io/docs/specs/otel/semantic-conventions/
- OpenAI Apps SDK: https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk
- ChatGPT MCP developer mode: https://help.openai.com/en/articles/12584461
