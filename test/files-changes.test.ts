import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore } from "../src/artifacts/index.ts";
import { createOperationContext, createRuntimeError } from "../src/core/index.ts";
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
    const sameFileSearch = files.search({ query: "needle", maxResults: 2 }, context);
    assert.equal(sameFileSearch.ok, true);
    if (!sameFileSearch.ok) return;
    assert.equal(sameFileSearch.data.matches.length, 2);
    assert.equal(sameFileSearch.meta.metrics.filesRead, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded line reads continue from a partial line", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "long.txt"), "abcdefghij\nnext\n");
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const result = new FileOperations({ rootDir: root }).read({ path: "long.txt", maxBytes: 5 }, context);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.content, "abcde");
    assert.equal(result.data.nextLine, 1);
    assert.equal(result.data.hasMore, true);
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

test("workspace patches are rejected when policy grants only read", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "guarded.txt"), "before\n");
    const tracer = new Tracer();
    const run = tracer.startRun({ actor: "model" });
    const context = createOperationContext({ traceId: run.traceId, runId: run.runId, actor: "model", effectPolicy: { allowedClasses: ["read"] } });
    const result = new FileOperations({ rootDir: root }).patch({ path: "guarded.txt", content: "after\n" }, context);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "EFFECT_NOT_ALLOWED");
    assert.equal(result.meta.effectClass, "workspace_write");
    assert.equal(readFileSync(join(root, "guarded.txt"), "utf8"), "before\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("persisted ChangeSet evidence supports rollback after manager recreation", () => {
  const root = fixture();
  const state = new SqliteStateStore(":memory:");
  try {
    const path = join(root, "fixture.txt");
    writeFileSync(path, "before\n");
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const first = new FileOperations({ rootDir: root, state });
    const before = first.read({ path: "fixture.txt" }, context);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const patched = first.patch({ path: "fixture.txt", expectedHash: before.data.contentHash, content: "after\n" }, context);
    assert.equal(patched.ok, true);
    if (!patched.ok) return;

    const recreated = new FileOperations({ rootDir: root, state });
    const rolledBack = recreated.rollback(patched.data.changeset, context);
    assert.equal(rolledBack.ok, true);
    assert.equal(new TextDecoder().decode(readFileSync(path)), "before\n");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch and rollback preserve executable mode while new files default private", () => {
  const root = fixture();
  try {
    const executable = join(root, "tool.sh");
    writeFileSync(executable, "#!/bin/sh\necho before\n");
    chmodSync(executable, 0o755);
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const files = new FileOperations({ rootDir: root });
    const read = files.read({ path: "tool.sh" }, context);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const patched = files.patch({ path: "tool.sh", expectedHash: read.data.contentHash, content: "#!/bin/sh\necho after\n" }, context);
    assert.equal(patched.ok, true);
    if (!patched.ok) return;
    assert.equal(statSync(executable).mode & 0o777, 0o755);
    const rolledBack = files.rollback(patched.data.changeset, context);
    assert.equal(rolledBack.ok, true);
    assert.equal(statSync(executable).mode & 0o777, 0o755);
    const created = files.patch({ path: "new.txt", content: "private\n" }, context);
    assert.equal(created.ok, true);
    assert.equal(statSync(join(root, "new.txt")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed unified patches fail closed without becoming replacement content", () => {
  const root = fixture();
  try {
    const path = join(root, "guarded.txt");
    writeFileSync(path, "before\n");
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const files = new FileOperations({ rootDir: root });
    const read = files.read({ path: "guarded.txt" }, context);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const result = files.patch({ path: "guarded.txt", expectedHash: read.data.contentHash, patch: "this is not a unified diff" }, context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "PATCH_INVALID");
    assert.equal(readFileSync(path, "utf8"), "before\n");
    const wrongNewCount = files.patch({ path: "guarded.txt", expectedHash: read.data.contentHash, patch: "@@ -1,1 +1,99 @@\n-before\n+after\n" }, context);
    assert.equal(wrongNewCount.ok, false);
    if (wrongNewCount.ok) return;
    assert.equal(wrongNewCount.error.code, "PATCH_INVALID");
    assert.equal(readFileSync(path, "utf8"), "before\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead-owner mutation lock is recovered without admitting a live owner", () => {
  const root = fixture();
  try {
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const files = new FileOperations({ rootDir: root });
    const lockPath = join(root, ".aer-mutation.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, hostname: hostname(), createdAt: new Date().toISOString(), nonce: "dead" }), { mode: 0o600 });
    const recovered = files.patch({ path: "recovered.txt", content: "ok\n" }, context);
    assert.equal(recovered.ok, true);

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), nonce: "live" }), { mode: 0o600 });
    const blocked = files.patch({ path: "blocked.txt", content: "no\n" }, context);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.error.code, "FILE_MUTATION_LOCKED");
    assert.equal(statSync(lockPath).isFile(), true);

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: "foreign-host", createdAt: "2000-01-01T00:00:00.000Z", nonce: "foreign" }), { mode: 0o600 });
    const foreignBlocked = files.patch({ path: "foreign-blocked.txt", content: "no\n" }, context);
    assert.equal(foreignBlocked.ok, false);
    if (foreignBlocked.ok) return;
    assert.equal(foreignBlocked.error.code, "FILE_MUTATION_LOCKED");

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), nonce: "reused", processStartIdentity: "not-the-current-process" }), { mode: 0o600 });
    const reusedRecovered = files.patch({ path: "reused-recovered.txt", content: "ok\n" }, context);
    assert.equal(reusedRecovered.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-write persistence failures report an unknown patch effect", () => {
  const root = fixture();
  const state = new SqliteStateStore(":memory:");
  try {
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const originalSave = state.saveEntity.bind(state);
    let saves = 0;
    state.saveEntity = (entity) => {
      saves += 1;
      if (saves === 3) throw createRuntimeError({ code: "STATE_STORE_BUSY", message: "busy", retryable: true, effect: "none" });
      originalSave(entity);
    };
    const files = new FileOperations({ rootDir: root, state });
    const result = files.patch({ path: "effect.txt", content: "written\n" }, context);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "STATE_STORE_BUSY");
    assert.equal(result.error.effect, "unknown");
    assert.equal(result.meta.status, "unknown");
    assert.equal(readFileSync(join(root, "effect.txt"), "utf8"), "written\n");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered before-image artifacts fail rollback before mutation and are not duplicated in SQLite", () => {
  const root = fixture();
  const state = new SqliteStateStore(":memory:");
  try {
    const path = join(root, "fixture.txt");
    writeFileSync(path, "before\n");
    const artifacts = new FileArtifactStore(join(root, ".artifacts"));
    const tracer = new Tracer();
    const { context } = contextFor(tracer);
    const first = new FileOperations({ rootDir: root, state, artifacts });
    const read = first.read({ path: "fixture.txt" }, context);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const patched = first.patch({ path: "fixture.txt", expectedHash: read.data.contentHash, content: "after\n" }, context);
    assert.equal(patched.ok, true);
    if (!patched.ok) return;
    const file = patched.data.changeset.files[0]!;
    assert.equal("rollbackBeforeBytes" in (state.getEntity("changeset_files", `${patched.data.changeset.id}:fixture.txt`)?.data ?? {}), false);
    const digest = file.beforeArtifactRef!.slice("artifact://sha256:".length);
    writeFileSync(join(artifacts.rootDir, "sha256", digest), "tampered\n", { mode: 0o600 });

    const recreated = new FileOperations({ rootDir: root, state, artifacts });
    const rollback = recreated.rollback(patched.data.changeset, context);
    assert.equal(rollback.ok, false);
    if (rollback.ok) return;
    assert.equal(rollback.error.code, "ROLLBACK_EVIDENCE_INTEGRITY_FAILED");
    assert.equal(readFileSync(path, "utf8"), "after\n");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
