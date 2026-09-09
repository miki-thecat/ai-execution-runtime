# Observability — Canonical Full Alpha Contract

Status: **mandatory foundation**  
Date: 2026-09-09

## 1. Purpose

AER must measure the AI-computer interface itself, not only errors. The first implemented operation must already answer:

- how many model-facing calls were required;
- how many internal calls semantic compression hid;
- how many bytes were observed vs returned;
- how much model polling was eliminated;
- what changed and what evidence verifies it;
- which executor/provider produced the result;
- whether a side effect is known, unknown, or applied.

This makes later AER-vs-RDC and AER-v1-vs-v2 comparisons empirical.

## 2. Trace hierarchy

```text
TRACE / RUN
  TASK
    OPERATION SPAN
      PROVIDER/INTERNAL CALL
      PROCESS
      ARTIFACT
    AGENT RUN
    CHANGESET
    VERIFICATION
```

One user-level job maps to one `run_id` where possible. New chats may resume a project/task but do not reuse an unrelated run.
## 3. Event schema

All events are append-only and versioned. Core fields:

```text
schema_version  event_id      trace_id
run_id          task_id?      span_id
parent_span_id? timestamp     type
actor           project_id?   device_id?
operation?      executor?     provider?
status?
```

Operational measurements:

```text
duration_ms          internal_calls
retries              poll_count_internal
poll_count_model      input_bytes
raw_output_bytes      returned_output_bytes
artifact_bytes        files_read
files_changed         exit_code?
signal?               token_input?
token_output?         token_cached?
```

Effect/evidence fields:

```text
effect_class    effect_state
idempotency_key?
changeset_id?   verification_id?
artifact_refs[] error_code?
```

High-cardinality or sensitive details belong in payload JSON or artifacts, not indexed columns.
## 4. Event vocabulary

Minimum Full Alpha events:

```text
run.started          run.completed        run.failed
run.cancelled        run.unknown
task.created         task.started          task.blocked
task.completed       task.failed           task.cancelled
task.unknown
operation.started    operation.completed   operation.failed
operation.cancelled  operation.unknown     process.started
process.completed
process.cancelled    process.unknown
artifact.created
changeset.created    changeset.applied     changeset.rolled_back
verification.started verification.completed
agent.started        agent.completed        agent.failed
agent.cancelled
approval.requested   approval.resolved
device.connected     device.disconnected
remote.requested     remote.completed
```

Provider-specific details stay in metadata rather than exploding the event taxonomy.

## 5. Semantic compression metrics

Every semantic operation records `internal_calls`, `raw_output_bytes`, and `returned_output_bytes` plus:

```text
compression_ratio = raw_output_bytes / max(returned_output_bytes, 1)
```

Example:

```json
{
  "operation": "github.snapshot",
  "internal_calls": 4,
  "raw_output_bytes": 58123,
  "returned_output_bytes": 3182,
  "compression_ratio": 18.27,
  "poll_count_model": 0
}
```
## 6. Polling metric

Differentiate:

- `poll_count_model`: repeated operations the AI/client had to issue;
- `poll_count_internal`: provider/runtime checks hidden behind one wait operation.

The goal is to drive model polling toward zero while allowing bounded internal polling when no subscription exists.

## 7. Privacy and redaction

Default telemetry records metadata, not content.

Default ON:

- operation/timing/status;
- counts/sizes/hashes;
- file paths when policy permits;
- diff summary and exit code;
- provider/model names;
- verification summaries;
- artifact references.

Default OFF / opt-in:

- full prompts/completions;
- full file contents;
- environment values;
- API keys/tokens/secrets;
- unnecessary full stdout/stderr;
- personal/email content.

Redaction occurs before persistence. Artifacts carry sensitivity classification and may be suppressed for secret-bearing sources.
## 8. Artifacts and run comparison

Large output is stored locally by digest. Events store summaries plus artifact references, not duplicate content. `artifact.read` supports bounded ranges.

`run.compare` must compare at least:

```text
status / duration
model-facing operations / internal calls
model polling / internal polling
raw bytes / returned bytes / compression ratio
retries / files changed
verification result / agent delegated
token usage when provider-supplied
```

## 9. Canonical store vs OpenTelemetry

AER's local SQLite event log is canonical because it works offline and survives telemetry ecosystem changes. OpenTelemetry is an exporter/integration target, not AER state authority.

Use familiar trace/span concepts so export is straightforward. Do not block Full Alpha on exact parity with still-evolving GenAI semantic conventions, and never enable sensitive prompt/file content merely to satisfy an exporter.

## 10. Dogfood benchmark scenarios

1. inspect repository state;
2. understand GitHub Issue/PR/CI state;
3. run a short command;
4. run a long test without model polling;
5. inspect a failing test log;
6. make a guarded file change and verify it;
7. delegate bounded work to Codex;
8. resume from a fresh client/chat;
9. publish/wait on a disposable GitHub path;
10. route one operation through the remote-device development path.

Initial evaluation target (not a merge gate): >=50% fewer model-facing calls than the RDC baseline, aspirational 70-80% for status/wait-heavy workflows, one-call project resume, zero model polling for supported waits, and bounded returned output regardless of raw log size.

## 11. Testing depth

Observability gets strong contract tests because every later comparison depends on it. Other Full Alpha features only need enough tests to prove they emit the canonical events and their happy path is measurable.
