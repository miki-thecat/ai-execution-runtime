# AGENTS.md

## Goal
Build AI Execution Runtime (AER): a persistent execution layer for AI clients to operate a computer directly or delegate bounded work, with durable state, verification, rollback evidence, and observability.

## Authority and context
Architecture authority is `docs/ARCHITECTURE.md`, `docs/OBSERVABILITY.md`, then `docs/FULL_ALPHA_PLAN.md`; the exact GitHub Issue defines the local scope and acceptance contract. Architecture wins on conflict. Do not redesign shared architecture inside an implementation Issue.

Use progressive disclosure: do not read canonical docs wholesale. Locate headings/terms first and read only sections relevant to the current Issue; when the Issue already restates the applicable contract, use it unless a concrete ambiguity requires the canonical doc.

## Full Alpha delivery
Work breadth-first toward a runnable product. Preserve contracts and dependency direction, complete the requested vertical capability, keep it observable, and add only contract/happy-path/critical workspace-or-effect safety tests. Defer exhaustive edge cases, compatibility polish, performance tuning, and speculative abstractions unless the Issue explicitly owns them.

## Non-negotiable invariants
- ChatGPT/AI client plans; AER v0 has no second LLM planner.
- Direct execution is first-class; Codex is an optional sibling executor, never runtime authority.
- Project/runtime owns durable state; chat/agent sessions do not.
- Meaningful operations emit canonical structured observability; large/raw output becomes bounded artifact evidence.
- Long waits stay inside AER rather than model polling.
- Semantic operations retain raw CLI fallback through Direct.
- Effects stay truthful and follow Issue-required idempotency/reversibility.
- MCP/CLI/App/remote are adapters over one runtime. Sandbox is a provider abstraction; no custom Firecracker stack in Full Alpha.
- Workers do not mutate GitHub task authority unless the controller explicitly owns that effect.

## Engineering baseline
TypeScript, Node.js 24+, pnpm, strict types; local-first SQLite behind an interface; official MCP TypeScript SDK v2 for MCP work. Prefer structured `gh --json`/API/GraphQL over parsing prose. Never persist secrets or full sensitive content in telemetry by default.

## Verification
For each capability, prove one happy path, required downstream contracts, critical workspace/effect safety where relevant, and observability. During iteration use focused checks; run broad verification after the final relevant edit. Do not create exhaustive matrices unless the Issue is hardening scope.
