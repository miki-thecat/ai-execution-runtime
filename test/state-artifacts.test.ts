import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore, MAX_ARTIFACT_READ_BYTES } from "../src/artifacts/index.ts";
import { createTraceId } from "../src/core/index.ts";
import { Tracer } from "../src/observability/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aer-state-test-"));
}

test("SQLite state survives close and reopen with canonical run events", () => {
  const directory = temporaryDirectory();
  const dbPath = join(directory, "aer.db");
  try {
    const first = new SqliteStateStore(dbPath);
    const tracer = new Tracer({ sink: first });
    const run = tracer.startRun({ traceId: createTraceId(), actor: "test" });
    const completed = run.complete();
    first.close();

    const reopened = new SqliteStateStore(dbPath);
    assert.equal(reopened.schemaVersion, 2);
    assert.deepEqual(reopened.listEvents({ runId: run.runId }).map((event) => event.type), [
      "run.started",
      "run.completed",
    ]);
    assert.deepEqual(reopened.getEvent(completed.eventId), completed);
    assert.equal(reopened.getRun(run.runId)?.status, "completed");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifacts use stable SHA-256 references and bounded reads", () => {
  const directory = temporaryDirectory();
  try {
    const store = new FileArtifactStore(directory);
    const content = "0123456789".repeat(MAX_ARTIFACT_READ_BYTES);
    const first = store.put(content, {
      mediaType: "text/plain",
      origin: "test",
      sensitivity: "internal",
    });
    const second = store.put(content, { mediaType: "application/octet-stream" });

    assert.equal(first.ref, second.ref);
    assert.equal(first.digest.length, 64);
    assert.equal(first.size, new TextEncoder().encode(content).byteLength);
    assert.equal(store.read(first.ref).byteLength, MAX_ARTIFACT_READ_BYTES);
    assert.equal(store.read(first.ref, { offset: 5, length: 20 }).byteLength, 20);
    assert.equal(store.metadata(first.ref)?.mediaType, "text/plain");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
