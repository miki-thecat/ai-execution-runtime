# Full Alpha Implementation Plan

Status: **canonical execution plan**  
Date: 2026-09-09  
Phase goal: **product breadth first; testing depth later**

## 1. Goal

Complete a Product-complete Full Alpha in which every major architectural path exists and one end-to-end workflow genuinely runs.

"Complete" in this phase means a feature exists, is wired into the common runtime, is observable, and has a working happy path. It does **not** mean production hardening, exhaustive tests, broad provider support, or polished UI.

## 2. Full Alpha Definition of Done

1. `aer doctor` reports runtime/provider capabilities.
2. A project can be initialized, inspected and resumed from persistent state.
3. CLI/MCP can run a direct command with bounded structured output.
4. Long-running work can start/wait/cancel without model-level polling.
5. Files can be read/searched and patched with a precondition hash.
6. A ChangeSet records the write and can roll back AER-mediated changes.
7. Verification commands execute and evidence persists.
8. Git/GitHub state is compressed into semantic snapshots.
9. GitHub waiting happens inside AER and publishing is effect-idempotent.
10. A bounded task can be delegated to Codex through the common executor contract.
11. Runtime state/events/artifacts survive client/chat changes.
12. MCP exposes the useful direct path using the official v2 SDK.
13. A local daemon owns long-running runtime state.
14. A development remote-device route works for one device/loopback path.
15. Sandbox provider capability detection works; Direct works; Docker Sandbox can report unavailable cleanly.
16. One Full Alpha E2E crosses the major layers.
17. `run.compare` exposes the metrics needed for RDC comparison.
18. CI has one `Verify` gate covering build/typecheck/smoke behavior.
## 3. Delivery philosophy

- **Breadth first:** do not polish one subsystem before the rest exists.
- **Small implementation batches:** breadth-first does not mean one giant Issue.
- **ChatGPT designs; Codex implements:** workers do not redefine architecture.
- **Observability first:** no capability is wired until canonical events exist.
- **Minimal tests now:** contract + happy path + critical workspace/effect safety only.

## 4. Pre-automation bootstrap

Before unattended ACP delivery is enabled, main must contain:

- canonical architecture/plan/observability docs;
- `AGENTS.md` declaring those docs authoritative;
- minimal Node/pnpm project and lockfile;
- CI job named exactly `Verify`;
- `.github/acp-autonomous.json` requiring `Verify`;
- lifecycle/risk labels used by ACP;
- clean lifecycle state with no abandoned `agent:running` Issue;
- any disposable canary required by ACP host qualification.

Do not mark implementation Issues `agent:ready` until this bootstrap is complete.

## 5. Issue contract rule

Every implementation Issue specifies goal, canonical docs, owned paths, forbidden scope, required interfaces, acceptance criteria, deferred work, observability requirements and GitHub-native blockers.

Target one Issue = one subsystem or one bounded vertical capability. Codex decides implementation detail inside the contract, not product architecture.
## 6. Planned implementation units

Stable FA IDs remain valid even if GitHub Issue numbers change.

### FA-00 — Foundation + observability spine
Owns `package.json`, lock/config/bootstrap as assigned, `src/core/**`, `src/observability/**`, `src/operations/**`.

Delivers RuntimeResult/Error/effect/context contracts, capabilities, a minimal operation registry, trace/run/span IDs, event schema/tracer/metrics/redaction API, test harness and one fake operation proving tracing end-to-end.

Must not implement shell/files/GitHub/Codex/MCP.

### FA-01 — Persistent state + artifacts
Owns `src/state/**`, `src/artifacts/**`.

Delivers `StateStore`, `node:sqlite` alpha implementation, migrations, append-only event persistence, core materialized state, content-addressed artifact store, bounded artifact read and restart/reopen smoke behavior.

### FA-02 — Direct shell/process execution
Owns `src/direct/**`.

Delivers `shell.run`, structured executable+args execution, process start/wait/cancel, timeout/cancellation, bounded stdout/stderr with artifact spill, process lifecycle/reconciliation semantics and canonical metrics/events.

### FA-03 — Files, search, ChangeSet, rollback
Owns `src/files/**`, `src/changes/**`.

Delivers confined bounded reads, hashes, `rg --json` search with fallback, atomic hash-guarded patching, ChangeSet creation, before/after hashes/diff summary and rollback for AER-mediated patches.
### FA-04 — Project, tasks, local Git, verification
Owns `src/project/**`, `src/tasks/**`, `src/verify/**`.

Delivers project registry/config, local Git snapshot, `project.inspect`, bounded `project.resume`, durable task state machine, verification configuration, `verify.run` and evidence persistence.

### FA-05 — GitHub semantic layer
Owns `src/github/**`.

Delivers `gh` capability/auth detection, structured provider, `github.snapshot`, `github.wait`, effect-idempotent `github.publish`, GitHub Issue dependency/work snapshots and compression metrics. Raw `gh` remains reachable through `shell.run`; no custom OAuth in Full Alpha.

### FA-06 — Agent executor + Codex
Owns `src/agents/**`.

Delivers `AgentExecutor`, capability detection, Codex `exec --json` adapter, structured terminal/usage/event capture, cancellation, AER-owned agent-run state, bounded summaries and artifact handling.

No multi-agent planner and no obligation to support every agent now.

### FA-07 — Policy + sandbox providers
Owns `src/policy/**`, `src/sandbox/**`.

Delivers effect classes, allow/deny/approval-required contract, basic budgets/deadlines, Direct execution environment, Docker Sandbox capability/adapter boundary and graceful unavailable state when `sbx` is absent.

This establishes an alpha contract, not production security certification.
### FA-08 — Local daemon + remote-device development path
Owns `src/server/**`, `src/remote/**`.

Delivers long-lived local runtime host, device identity/capabilities/presence, authenticated local/dev transport envelope, request IDs/deadlines/idempotency propagation, one-device/loopback E2E and honest reconnect/recovery state.

No production cloud account, billing or fleet system.

### FA-09 — CLI + MCP + ChatGPT/App surface
Owns `src/cli/**`, `src/mcp/**`, `app/**` (or equivalent thin packaging).

Delivers the `aer` CLI, stable JSON mode, `aer doctor`, official MCP TS SDK v2 server with explicit modern-protocol support, compact operations backed by the common runtime, local/stdio/Streamable HTTP path as appropriate, and Apps SDK-ready packaging/docs without duplicating runtime logic.

Do not use deprecated MCP Logging as AER state and do not make MCP Tasks the canonical task model.

### FA-10 — Full E2E + dogfood benchmark
Owns `src/benchmark/**`, `examples/**`, `test/e2e/**`, final README usage.

Delivers one complete Full Alpha scenario, run inspection/comparison, RDC comparison scenarios, compact metrics report and a README quickstart that matches real implementation.

## 7. Canonical DAG

```text
FA-00 Foundation + Observability
          |
          v
FA-01 State + Artifacts
          |
          v
FA-02 Direct Process
          |
          v
FA-03 Files/Changes
          |
   +------+------+------+------+
   |      |      |      |      |
   v      v      v      v      |
 FA-04  FA-05  FA-06  FA-07    |
 Project GitHub Codex  Policy   |
   +------+------+------+-------+
                 |
                 v
               FA-08 Daemon/Remote
                 |
                 v
               FA-09 CLI/MCP/App
                 |
                 v
               FA-10 Full E2E/Bench
```
GitHub-native Issue dependencies encode actual blockers. The middle wave is path-separated so qualified two-lane ACP execution can parallelize safely after contracts stabilize.

## 8. File-conflict strategy

- FA-00 creates shared contracts once; downstream Issues consume rather than redesign them.
- Each middle-wave Issue owns a distinct directory.
- No middle-wave Issue edits a central MCP/tool catalog; FA-09 composes the surface after providers exist.
- Anticipate package dependencies in bootstrap/FA-00; later `package.json` edits must be minimal.
- README final usage belongs to FA-10.
- A downstream contract problem is a blocker/report, not permission to rewrite core architecture.

## 9. Model routing

Suggested ACP routing:

```text
FA-00 complex  / Luna xhigh
FA-01 standard / Luna high
FA-02 standard / Luna high
FA-03 standard / Luna high
FA-04 complex  / Luna xhigh
FA-05 complex  / Luna xhigh
FA-06 complex  / Luna xhigh
FA-07 complex  / Luna xhigh
FA-08 complex  / Luna xhigh
FA-09 standard / Luna high
FA-10 complex  / Luna xhigh
```

Use Sol only for a genuinely critical architecture/security correction. Do not auto-escalate ordinary failures.

## 10. Parallelization

Default to one lane through FA-03. After FA-03 is on main, dependency-safe middle-wave work may use two qualified lanes, for example `FA-04 || FA-05` then `FA-06 || FA-07`.

Only Issues with non-overlapping owned paths receive `agent:parallel`. Speed is not sufficient justification for unsafe parallel authority.
## 11. Autonomous-night rules

Before sleep:

1. live-read GitHub main, Issue dependencies, CI, ACP state and model quota;
2. ensure repo bootstrap and `Verify` policy are on main;
3. ensure no stale `agent:running` state;
4. mark only contract-complete Issues `agent:ready`;
5. preserve GitHub-native blockers rather than relying on prose ordering;
6. enable only already-qualified ACP capacity;
7. do not hide high-risk scope inside an unattended ordinary Issue.

A repeated correction failure means re-check the Issue contract/architecture/test oracle; do not loop indefinitely.

## 12. Acceptance style

Every Issue uses short binary completion criteria:

```text
DONE when:
- one happy path works;
- implementation matches canonical contracts;
- canonical observability is emitted;
- model-facing output is bounded;
- required smoke/contract/safety checks pass;
- no deferred subsystem was expanded.
```

## 13. Intentionally deferred today

Do not optimize unit coverage percentage, exhaustive errors, broad OS/provider compatibility, micro-performance, production cloud infrastructure, polished UI, every coding agent, full PTY fidelity or enterprise governance before FA-10.

## 14. After FA-10

Dogfood first. Then use measured runs to rank work by tool-call cost, polling, output volume, latency, retries, reliability failures and human intervention. Expand tests around observed failures, harden security/remote isolation, and add providers only where demand or measurements justify them.
