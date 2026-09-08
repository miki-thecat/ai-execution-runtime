# Full Alpha Issue DAG

Status: canonical mapping for the 2026-09-09 Full Alpha program.

## Issue map

| FA ID | GitHub | Scope | Model route | Parallel |
|---|---:|---|---|---|
| FA-00 | #2 | Foundation + observability spine | complex | no |
| FA-01 | #3 | Persistent state + artifacts | standard | no |
| FA-02 | #4 | Direct shell/process | standard | no |
| FA-03 | #5 | Files/search/ChangeSet/rollback | standard | no |
| FA-04 | #6 | Project/task/Git/verification | complex | first lane |
| FA-05 | #7 | GitHub semantic layer | complex | authorized |
| FA-06 | #8 | Codex executor | complex | authorized |
| FA-07 | #9 | Policy/sandbox | complex | authorized |
| FA-08 | #10 | Daemon/remote device | complex | no |
| FA-09 | #11 | CLI/MCP/ChatGPT surface | standard | no |
| FA-10 | #12 | Full E2E + benchmark | complex | no |

Program tracker: #1.

## Native dependency graph

```text
#2 FA-00 Foundation/Observability
 |
 v
#3 FA-01 State/Artifacts
 |
 v
#4 FA-02 Direct Process
 |
 v
#5 FA-03 Files/Changes
``````text
       +----------+----------+----------+
       |          |          |          |
       v          v          v          v
#6 FA-04     #7 FA-05   #8 FA-06   #9 FA-07
Project      GitHub      Codex       Policy/Sandbox
       |          |          |          |
       +----------+----------+----------+
                  |
                  v
        #10 FA-08 Daemon/Remote
                  |
                  v
        #11 FA-09 CLI/MCP/App
                  |
                  v
        #12 FA-10 Full E2E/Bench
```

Exact GitHub native blockers:

```text
#3  <- #2
#4  <- #3
#5  <- #4
#6  <- #5
#7  <- #5
#8  <- #5
#9  <- #5
#10 <- #6, #9
#11 <- #6, #7, #8, #9, #10
#12 <- #11
```

The duplicate-looking #11 blockers are deliberate explicit gates: the public surface must not compose a provider that has not independently landed even if another blocker is transitively related.
## Readiness policy

At plan creation time **none of #2-#12 carries `agent:ready`**. This is intentional. Repository automation bootstrap must land first.

When bootstrap is qualified:

1. grant `agent:ready` to contract-complete implementation Issues;
2. let native blockers determine actual eligibility;
3. keep capacity one through #5 unless a qualified capacity-two host is intentionally enabled;
4. after #5, only path-separated Issues with explicit `agent:parallel` may occupy the second same-repository lane;
5. #10/#11/#12 re-serialize integration.

## Why this DAG is shaped this way

- Observability and core contracts must exist before any real operation, otherwise early behavior becomes unmeasurable.
- State/artifacts precede execution so direct/agent/GitHub operations share one durable evidence model.
- Direct execution precedes higher providers because `git`, `gh`, verification and Codex all need observable process execution.
- Files/ChangeSets land before the middle wave so every later subsystem can use guarded project I/O.
- Project, GitHub, Codex and sandbox are deliberately directory-isolated to permit safe parallel work.
- Remote/daemon waits for project/task and policy contracts because it must transport the same operation/effect semantics, not invent a second runtime.
- CLI/MCP/App land late so they compose stable operations rather than drive architecture.
- Full E2E is last and is an acceptance/measurement Issue, not a redesign Issue.

## Source of truth

GitHub native dependencies are execution authority. This document explains the DAG; it does not replace the dependency relationships recorded on GitHub.
