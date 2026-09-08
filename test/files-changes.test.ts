import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore } from "../src/artifacts/index.ts";
import { createOperationContext } from "../src/core/index.ts";
import { FileOperations } from "../src/files/index.ts";
import { InMemoryEventSink, Tracer } from "../src/observability/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "aer-files-test-"));
}

function contextFor(tracer: Tracer) {
  const run = tracer.startRun({ actor: "model" });
  return { run, context: createOperationContext({ traceId: run.traceId, runId: run.runId, actor: "model" }) };
}

test("file reads and searches are bounded and carry content identity", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "notes.txt"), "alpha\nneedle one\nneedle two\nlast\n");
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const files = new FileOperations({ rootDir: root, maxReadBytes: 10, maxSearchResults: 1 });
    const read = files.read({ path: "notes.txt", startLine: 2, endLine: 4 }, context);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.data.content, "needle one");
    assert.equal(read.data.totalLines, 4);
    assert.equal(read.data.totalSizeBytes, new TextEncoder().encode("alpha\nneedle one\nneedle two\nlast\n").byteLength);
    assert.equal(read.data.contentHash.length, 64);
    assert.equal(read.data.hasMore, true);
    const search = files.search({ query: "needle" }, context);
    assert.equal(search.ok, true);
    if (!search.ok) return;
    assert.equal(search.data.matches.length, 1);
    assert.equal(search.data.matches[0]?.path, "notes.txt");
    assert.equal(search.data.matches[0]?.line, 2);
    assert.equal(search.data.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic file operations reject symlink escapes", () => {
  const root = fixture();
  const outside = fixture();
  try {
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(join(outside, "secret.txt"), join(root, "linked.txt"));
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const files = new FileOperations({ rootDir: root });
    const read = files.read({ path: "linked.txt" }, context);
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.error.code, "FILE_PATH_ESCAPE");
    const write = files.patch({ path: "linked.txt", content: "overwrite" }, context);
    assert.equal(write.ok, false);
    if (write.ok) return;
    assert.equal(write.error.code, "FILE_PATH_ESCAPE");
    assert.equal(String(write.error.effect), "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guarded patch records evidence and rollback refuses stale files", () => {
  const root = fixture();
  const state = new SqliteStateStore(":memory:");
  try {
    const path = join(root, "fixture.txt");
    writeFileSync(path, "before\n");
    const sink = new InMemoryEventSink();
    const tracer = new Tracer({ sink });
    const artifacts = new FileArtifactStore(join(root, ".artifacts"));
    const files = new FileOperations({ rootDir: root, tracer, artifacts, state });
    const { run, context } = contextFor(tracer);
    const beforeHash = files.read({ path: "fixture.txt" }, context);
    assert.equal(beforeHash.ok, true);
    if (!beforeHash.ok) return;
    const patched = files.patch({ path: "fixture.txt", expectedHash: beforeHash.data.contentHash, content: "after\n" }, context);
    assert.equal(patched.ok, true);
    if (!patched.ok) return;
    assert.equal(patched.data.changeset.status, "applied");
    assert.equal(patched.data.changeset.files[0]?.beforeHash, beforeHash.data.contentHash);
    assert.equal(patched.data.changeset.files[0]?.afterHash, patched.data.afterHash);
    assert.equal(state.getEntity("changesets", patched.data.changeset.id)?.status, "applied");
    assert.ok(sink.events.some((event) => event.type === "changeset.applied" && event.changesetId === patched.data.changeset.id));

    const stale = files.patch({ path: "fixture.txt", expectedHash: beforeHash.data.contentHash, content: "blind overwrite\n" }, context);
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error.code, "FILE_HASH_MISMATCH");
    assert.equal(new TextDecoder().decode(readFileSync(path)), "after\n");

    const rolledBack = files.rollback(patched.data.changeset, context);
    assert.equal(rolledBack.ok, true);
    assert.equal(new TextDecoder().decode(readFileSync(path)), "before\n");
    assert.ok(sink.events.some((event) => event.type === "changeset.rolled_back" && event.changesetId === patched.data.changeset.id));
    run.complete();
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
