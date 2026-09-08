# AI Execution Runtime

A persistent, AI-native execution layer that lets ChatGPT and other AI clients operate a computer directly or delegate work to specialized agents.

**Direct CLI. Semantic compression. Persistent state. Observable execution. Optional agents.**

## Current phase

The repository is in **Product-complete Full Alpha** development. The priority is to wire the entire product from AI client to local/remote execution before deep hardening.

## Canonical design

- [Architecture](docs/ARCHITECTURE.md)
- [Observability](docs/OBSERVABILITY.md)
- [Full Alpha implementation plan](docs/FULL_ALPHA_PLAN.md)
- [Agent/worker rules](AGENTS.md)

## Core model

```text
ChatGPT / AI client
        |
        v
   AI Execution Runtime
        |
   +----+-------------------+
   |                        |
 DIRECT                  DELEGATE
 shell/files/git/gh        Codex
   |                        |
   +-----------+------------+
```               v
      state + artifacts + verify
               |
       local / sandbox / remote
```

AER is deliberately provider-neutral. MCP, GitHub CLI, Codex, remote transports, and microVM systems are adapters/backends around the runtime's own durable task/effect/observability model.
