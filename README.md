# AI Execution Runtime

AER is a persistent, local-first execution layer for AI clients. It provides bounded direct execution, semantic file/GitHub operations, guarded ChangeSets, trusted verification, optional Codex delegation, durable artifacts, and observable local daemon/MCP routes.

## Full Alpha quickstart

Requires Node 24+. Install dependencies and run the complete deterministic walking skeleton:

```sh
pnpm install --frozen-lockfile
pnpm benchmark
```

The scenario exercises project init/inspect/resume, direct output and artifacts, file read/search, a hash-guarded patch and ChangeSet, verification, GitHub snapshot/wait, Codex isolation, run inspection/comparison, daemon routing, official MCP list/call, Plugin metadata, and the first scripted RDC dogfood baseline. GitHub and Codex accounts are not required: the benchmark uses bounded local fixtures. Secure MCP Tunnel is reported as `SKIPPED` unless a client is installed and authorization is explicitly verifiable.

## CLI and MCP

```sh
pnpm aer -- doctor
pnpm aer -- init .
pnpm aer -- inspect
pnpm aer -- resume
pnpm aer -- run 'printf hello'
pnpm aer -- runs list
pnpm aer -- runs compare <run-id-a> <run-id-b>
pnpm aer -- mcp                 # modern MCP v2 stdio
pnpm aer -- mcp --http          # Streamable HTTP on 127.0.0.1:8787
```

All automation-facing commands return structured JSON. AER owns project, task, effect, budget, artifact, and run state; clients can narrow budgets and assert effects, but cannot raise runtime limits or downgrade registered effect classes. Direct and delegated execution do not receive ambient secret-like environment values by default.

Docker Sandbox, external Codex, GitHub account access, and Secure MCP Tunnel are capability-dependent. Production cloud relay, billing, public Plugin launch, exhaustive protocol/provider hardening, and adversarial replay matrices remain deferred after Full Alpha.

## Design references

- [Architecture](docs/ARCHITECTURE.md)
- [Observability](docs/OBSERVABILITY.md)
- [Full Alpha implementation plan](docs/FULL_ALPHA_PLAN.md)
- [Full Alpha Issue DAG](docs/ISSUE_DAG.md)
- [Agent/worker rules](AGENTS.md)
