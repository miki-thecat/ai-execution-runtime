# AER Post-Beta to v1.0 Plan

Status: **canonical post-Beta execution plan**  
Date: 2026-09-11  
Strategy: **ChatGPT governs Goal boundaries; AER orchestrates; Codex executes bounded work**

## 1. Objective

Finish AER as a dependable local-first execution runtime, not as an eternally expanding research project. v1.0 is complete when AER can drive sustained real software work with bounded autonomous Codex execution, truthful durable state, recovery, verification, GitHub delivery, installability, and documented safety boundaries.

New protocol features, provider breadth, cloud relay, billing, polished GUI, and enterprise governance are not v1.0 blockers unless real dogfood proves they are required for the core product.

## 2. Operating model

The control hierarchy is:

1. **Human** sets product intent and may stop or redirect work.
2. **ChatGPT Goal Governor** researches, defines each Goal contract, performs Goal-exit audits, and handles architecture/security/judgment escalations.
3. **AER Orchestrator** owns canonical Goal/task/run/effect state, dispatch, bounded concurrency, verification, retry/reconciliation, GitHub waits, and stop conditions.
4. **Codex workers** perform scoped implementation/review/test work inside isolated per-Issue workspaces. Codex never becomes runtime authority.

Goal state must survive agent/chat/process loss. A Codex thread, `/goal`, scratchpad, or tracker comment may help a worker but is never the canonical Goal record.

## 3. Orchestration reference model

OpenAI Symphony is the primary external reference for Goal 2. Reuse its proven concepts where they fit:

- issue-tracker-driven dispatch;
- isolated per-Issue workspaces;
- repository-owned workflow policy;
- bounded concurrency;
- stop/retry/reconciliation rules;
- coding-agent app-server integration;
- operator-visible observability.

Do **not** copy Symphony mechanically. AER already owns stronger durable SQLite state, effect truth/UNKNOWN semantics, project/device authority, semantic GitHub operations, verification, artifacts, and remote execution. Preserve those AER invariants rather than replacing them with tracker-only or in-memory authority.

Default implementation direction for Goal 2 is a TypeScript, Symphony-spec-inspired orchestration layer inside AER. Reusing the experimental reference implementation as a runtime dependency requires a separate evidence-backed decision.

## 4. Goal execution rules

- **Goals are fixed; Issues are dynamic.** Do not pre-generate a giant v1 backlog.
- Each Issue must be justified by the active Goal contract, observed failure, missing acceptance evidence, or a required dependency.
- One worker owns one bounded Issue/worktree at a time.
- Start a fresh Codex thread for a new Issue by default. Continuation turns may reuse the thread only within that Issue.
- Codex may iterate until deterministic acceptance passes, but may not silently widen Goal scope.
- AER owns CI waiting and other long waits; model-level polling should remain zero.
- AER may auto-merge only when the active Goal policy explicitly permits it and exact-head verification is green.
- Stop and escalate for material security/authority/data-loss concerns, irreconcilable UNKNOWN effects, architecture changes, or human product judgment.
- Deferred hardening stays deferred unless evidence promotes it.

## 5. Goal 1 — Operational Core Readiness

**Purpose:** prove the merged Beta can perform ordinary real development without semantic lies or recurring operator workarounds.

Current dogfood fixes #52 and #54 count toward this Goal.

Required loop:

`resume -> inspect -> choose bounded work -> Codex -> verify -> GitHub -> CI wait -> merge -> resume`

### Exit gate

- at least 10 real development/dogfood cycles are recorded;
- the final 5 consecutive cycles have no material AER blocker;
- `blockers=[]` and no unexplained `unknownEffects` at clean checkpoints;
- genuine active work remains visible while observation/self-runs do not fabricate work;
- full deterministic tests, E2E, and benchmark remain green;
- second-device path has no regression when exercised by a relevant cycle;
- remaining friction is classified as Goal 2+, deferred hardening, or non-blocking product polish.

**Goal-exit owner:** ChatGPT audit.

## 6. Goal 2 — Autonomous Development Orchestration

**Purpose:** eliminate the repeated human/ChatGPT instruction "do the next task" for bounded development work.

### Required capability

- durable AER Goal contract with machine-checkable exit criteria;
- just-in-time task/Issue selection from GitHub plus AER state;
- deterministic per-Issue worktree lifecycle;
- bounded scheduler with conservative initial concurrency;
- fresh Codex worker launch via a supported automation surface (App Server or SDK preferred after compatibility spike);
- worker continuation for test/review feedback inside the same Issue;
- deterministic verification gate before publish/merge;
- internal GitHub CI wait and exact-head merge guard;
- retry/backoff/reconcile without duplicate effects;
- explicit blocked/escalated terminal state when judgment is required;
- repository-owned workflow instructions, kept distinct from canonical runtime state.

### Symphony decision gate

Before implementing the scheduler, compare current AER against the current Symphony spec and Codex App Server schema. Adopt semantics, not unnecessary dependencies. Document any deliberate divergence.

### Exit gate

- at least 10 consecutive bounded Issues can progress without a user sending "next";
- restart between Issues does not lose the Goal or queue position;
- no duplicate Issue dispatch, PR creation, or merge;
- concurrency never violates project/worktree authority;
- failures either recover automatically or stop truthfully as blocked/unknown;
- architecture/security escalations reach ChatGPT instead of being improvised by Codex.

**Goal-exit owner:** ChatGPT audit plus autonomous-loop evidence.

## 7. Goal 3 — Unattended Recovery and Fault Tolerance

**Purpose:** make overnight operation safe enough that absence of a human does not turn ordinary failures into corrupted state or duplicate effects.

Required scenarios include Codex crash, AER restart, machine reboot, stale worktree/branch, verification failure, CI failure/timeout, GitHub transient/rate limit, merge conflict, remote disconnect, and ambiguous external write outcomes.

### Exit gate

- deterministic recovery tests cover each material scenario;
- every scenario ends in automatic recovery or a truthful blocked/unknown state;
- no blind replay of ambiguous external writes;
- no loss of canonical Goal/task/run/effect state across daemon restart;
- one bounded unattended soak completes with zero operator intervention unless an intentionally injected escalation condition is reached.

**Goal-exit owner:** ChatGPT recovery audit.

## 8. Goal 4 — Context, Token, and Operational Efficiency

**Purpose:** reduce agent cost and latency only after real autonomous traces exist.

Work is measurement-driven: semantic context packs, progressive disclosure, stable repository instructions, bounded artifacts, prompt/cache stability, model routing, and elimination of redundant reads/polls.

### Exit gate

- AER records per-worker input/output/cached token metrics when the provider exposes them;
- a representative small/medium Issue corpus has a repeatable baseline;
- no routine worker requires an unbounded repository dump;
- model-facing polling remains zero for AER-owned waits;
- material regressions in latency/token/output budget are detectable;
- optimization targets are set from measured distributions rather than guessed universal thresholds.

**Goal-exit owner:** ChatGPT efficiency audit.

## 9. Goal 5 — Installation, Upgrade, and Daily Operability

**Purpose:** move from "works on the development machine" to a product another supported machine can install and operate.

Required surface includes install, doctor, init, start/restart, status/resume, upgrade/migrate, and uninstall/data-preservation guidance.

### Exit gate

- clean-machine install succeeds on the explicitly supported v1 platforms;
- initial project setup reaches trusted verification without undocumented manual state surgery;
- daemon lifecycle is documented and reliable;
- schema/config migration is tested from the oldest supported v1 precursor state;
- upgrade preserves durable state or fails closed with actionable recovery guidance;
- secrets and runtime state locations are documented;
- README alone is sufficient for the supported happy path.

**Goal-exit owner:** ChatGPT clean-install audit.

## 10. Goal 6 — Security and Compatibility Release Gate

**Purpose:** promote only evidence-backed parts of deferred hardening into the v1 release gate.

Re-rank #29 from observed traces and the current MCP/Codex contracts. Required review areas are authority boundaries, credential leakage, path/symlink confinement, replay/idempotency, artifact/state integrity, remote trust, Codex isolation/version compatibility, and the MCP surface actually shipped by v1.

### Exit gate

- no known P0/P1-equivalent security, data-loss, or authority defect;
- supported Codex version/capability detection fails closed on incompatible automation contracts;
- shipped MCP transport/surface passes the selected conformance and authorization checks;
- release-critical recovery/idempotency paths have adversarial coverage proportional to observed risk;
- unresolved #29 items are explicitly classified as post-v1 rather than silently forgotten.

**Goal-exit owner:** ChatGPT security/compatibility audit.

## 11. Goal 7 — v1.0 Release Candidate and Completion

**Purpose:** freeze scope, prove the actual product, publish a bounded support contract, and declare completion.

### Final Definition of Done

- Goals 1-6 have explicit PASS evidence;
- at least 20 real development cycles have been completed under AER, with the final 10 free of material AER blockers;
- autonomous Issue execution can run without repeated user "next" prompts;
- restart/reboot recovery and real second-device execution are proven;
- trusted verification, GitHub PR/CI/merge, truthful UNKNOWN, bounded output, and Codex isolation remain green;
- clean install and upgrade/migration evidence exist for supported platforms;
- no known release-blocking security/authority/data-loss defect remains;
- README, architecture, operating model, known limitations, and recovery guidance match the shipped behavior;
- one final integrated acceptance suite passes on the exact release commit.

At this gate AER v1.0 is **complete**. Future MCP/Codex features, provider expansion, cloud relay, UI, billing, and enterprise features become v1.x/v2 work unless they are required to fix a release defect.

**Goal-exit owner:** ChatGPT final release audit; human retains release/stop authority.

## 12. ChatGPT intervention policy

ChatGPT is expected at Goal boundaries, not every Issue. Invoke it when:

- starting a new Goal and fixing its contract;
- evaluating Goal exit evidence;
- architecture or product scope would change;
- material security/authority/data-loss risk appears;
- a truthful UNKNOWN cannot be resolved mechanically;
- Codex/AER reaches an explicit judgment-required state;
- performing the final release audit.

Routine implementation, local review, tests, CI remediation, and bounded merge shepherding should move toward Codex+AER autonomy.

## 13. Completion forecast policy

Time estimates are secondary to exit evidence. For planning only, the current post-Beta state suggests Goal 1 is near completion; Goals 2-7 are expected to be measured in focused days to a few weeks rather than months if autonomous throughput remains healthy. Do not trade away authority, effect truth, or recovery semantics to hit a calendar estimate.

## 14. Immediate next action

Continue Goal 1 real dogfood. Do not implement Goal 2 orchestration yet. After Goal 1 passes, ChatGPT performs the first formal Goal-exit audit, refreshes Symphony/Codex/MCP compatibility evidence, and authorizes Goal 2.
