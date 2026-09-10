import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AERDaemon, createSemanticOperationEnvelope } from "../src/index.ts";
import { registerMcpOperations } from "../src/mcp/index.ts";

test("run.compare confines normalized run IDs and aliases to the target project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aer-run-compare-"));
  const daemon = registerMcpOperations(new AERDaemon({ dataRoot: directory }));
  try {
    const projects = ["a", "b"].map((name) => {
      const rootDir = join(directory, name);
      mkdirSync(rootDir);
      return daemon.registerProject({ rootDir, writeConfig: false });
    });
    const projectA = projects[0]!;
    const projectB = projects[1]!;
    const a = daemon.tracer.startRun({ projectId: projectA.projectId }).runId;
    const a2 = daemon.tracer.startRun({ projectId: projectA.projectId }).runId;
    const b = daemon.tracer.startRun({ projectId: projectB.projectId }).runId;
    const compare = (input: Record<string, unknown>) => daemon.execute(createSemanticOperationEnvelope({
      operation: "run.compare", projectId: projectA.projectId, input,
    }));

    for (const input of [{ runIds: [a, a2] }, { a, b: a2 }]) {
      const result = await compare(input);
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual((result.data as { runs: { runId: string }[] }).runs.map((run) => run.runId), [a, a2]);
    }
    for (const input of [{ runIds: [b] }, { runIds: [a, b] }, { a: b }, { a, b }, { a: b, b: a }, { runIds: ["missing-run"] }]) {
      const result = await compare(input);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "PROJECT_AUTHORITY_MISMATCH");
        assert.equal(result.error.effect, "none");
      }
      assert.equal("data" in result, false);
    }
  } finally {
    await daemon.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
