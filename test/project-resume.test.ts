import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AERDaemon, createSemanticOperationEnvelope } from "../src/index.ts";
import { FileArtifactStore } from "../src/artifacts/index.ts";
import { Tracer } from "../src/observability/index.ts";
import { createProjectResumeOperation, ProjectRuntime, type ProjectResume } from "../src/project/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";

test("operation-level resume excludes itself and preserves pre-existing active runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "aer-resume-"));
  const state = new SqliteStateStore(join(root, "state.db"));
  try {
    const runtime = new ProjectRuntime({ state, artifacts: new FileArtifactStore(join(root, "artifacts")) });
    const project = runtime.register({ rootDir: root, name: "Resume" });
    const daemon = new AERDaemon({ dataRoot: root, state, projects: runtime.registry });
    daemon.register(createProjectResumeOperation(runtime));
    daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online", capabilities: { operations: ["project.resume"] } });
    const resume = () => daemon.execute(createSemanticOperationEnvelope({
      operation: "project.resume", projectId: project.projectId,
      input: { project: project.projectId, itemLimit: 1 },
    }));

    const clean = await resume();
    assert.equal(clean.ok, true, JSON.stringify(clean));
    if (!clean.ok) return;
    assert.deepEqual((clean.data as ProjectResume).activeRuns, []);

    const existing = new Tracer({ sink: state }).startRun({ projectId: project.projectId, actor: "runtime" });
    const resumed = await resume();
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    if (!resumed.ok) return;
    assert.deepEqual((resumed.data as ProjectResume).activeRuns.map((run) => run.runId), [existing.runId]);
    assert.equal(state.getRun(existing.runId)?.status, "running");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
