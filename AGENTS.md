# AGENTS.md

## Product goal
Build AI Execution Runtime: a persistent, AI-native execution layer that lets ChatGPT/AI clients operate a computer directly or delegate bounded work to specialized agents, with durable state, verification, rollback evidence, and observability.

## Architecture authority
During Product-complete Full Alpha, these files are canonical:

1. `docs/ARCHITECTURE.md`
2. `docs/OBSERVABILITY.md`
3. `docs/FULL_ALPHA_PLAN.md`
4. the exact GitHub Issue contract being implemented

If implementation convenience conflicts with those documents, the documents win. Do not redesign architecture inside an implementation Issue.

## Current delivery phase
**PRODUCT-COMPLETE FULL ALPHA — breadth first.**

Priority order:
1. preserve canonical contracts and dependency direction;
2. complete the requested vertical capability;
3. keep the product path runnable and observable;
4. add only tests required for the contract, happy path, and critical workspace/effect safety;
5. defer exhaustive edge cases, compatibility polish, performance tuning, and speculative abstractions.

## Non-negotiable architecture
- ChatGPT/AI client is the planner/control brain; AER v0 has no second LLM planner.
- Direct execution is first-class. Codex is an optional sibling executor, never a mandatory hop.
- Project/runtime owns durable state; chat and agent sessions do not.
- Every meaningful operation emits canonical structured observability.- Large/raw outputs become local artifacts; model-facing results stay bounded.
- Long waits happen inside AER rather than through repeated model polling.
- Semantic operations retain raw CLI fallback through direct execution.
- Writes/effects expose effect state and are idempotent/reversible where the Issue contract requires it.
- MCP/CLI/App/remote are adapters over one internal runtime, not separate implementations.
- Sandbox is a provider abstraction. Do not implement custom Firecracker infrastructure in Full Alpha.

## Issue discipline
- Work only on the exact Issue scope and owned paths.
- Do not expand into deferred subsystems just because they are nearby.
- Do not silently change shared core interfaces from a downstream Issue. If the contract is insufficient, stop and report the blocker.
- Do not create another planner/router/agent framework inside AER.
- Do not mutate GitHub task authority from the worker unless the controller explicitly owns that effect.

## Engineering baseline
- TypeScript / Node.js 24+, pnpm, strict types.
- Official MCP TypeScript SDK v2 for MCP work.
- Local-first SQLite state behind an interface.
- `git` and `gh` are providers/sources of truth, not things to reimplement.
- Prefer structured `gh --json` / API / GraphQL and compact semantic snapshots.
- Never persist secrets or full sensitive content in telemetry by default.

## Full Alpha testing rule
Each implemented capability needs one happy path, required downstream contract tests, critical workspace/effect safety tests where relevant, and evidence that observability is emitted.

Do not spend an Issue on exhaustive test matrices unless the Issue explicitly asks for hardening.
