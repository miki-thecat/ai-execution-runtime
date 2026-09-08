# AGENTS.md

## Product goal
Build an AI-native execution runtime that lets ChatGPT/AI clients operate a computer directly or delegate work to specialized agents.

## Delivery rule
Prefer a thin end-to-end implementation over deep isolated subsystems. Keep the main branch runnable and observable.

## Core architecture
- Direct execution is first-class; Codex is optional, not a mandatory hop.
- Runtime owns persistent project/task state; chats and agents do not.
- Every meaningful execution emits structured events from day one.
- Large outputs become artifacts; model-facing results stay compact.
- Writes should be diff-first, reversible where practical, and independently verifiable.
- Sandbox is a provider abstraction. Start with direct/local execution; add stronger isolation behind the same contract.

## Full-alpha scope
Direct shell/process/files/search, project inspect/resume, SQLite state/event log, artifacts, verification, MCP surface, Codex adapter skeleton, remote-transport abstraction, sandbox abstraction, and benchmark hooks.

## Engineering constraints
- TypeScript on Node.js 24+, pnpm, strict types, Vitest.
- Avoid premature cloud, billing, RBAC, GraphRAG, custom VM infrastructure, or fancy UI.
- Never store secrets or full sensitive content in telemetry by default.
- Tests and typecheck are required for implemented behavior.
- Keep interfaces small and capability-driven.
