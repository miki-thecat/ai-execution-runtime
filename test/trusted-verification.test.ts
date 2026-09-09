import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore } from "../src/artifacts/index.ts";
import type { ProjectId } from "../src/core/index.ts";
import { InMemoryEventSink, Tracer } from "../src/observability/index.ts";
import { projectConfigPath, ProjectRegistry, ProjectRuntime, writeProjectConfig, type ProjectIdentity } from "../src/project/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";
import { VerificationRunner } from "../src/verify/index.ts";

function fixture(prefix: string): { root: string; runtimeRoot: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-project-`));
  const runtimeRoot = mkdtempSync(join(tmpdir(), `${prefix}-runtime-`));
  return { root, runtimeRoot, dbPath: join(runtimeRoot, "aer.db") };
}

test("trusted verification plan survives reopen, rejects drift before spawn, and updates explicitly", async () => {
  const { root, runtimeRoot, dbPath } = fixture("aer-fa-r3-plan");
  const marker = join(root, "changed-command-ran");
  let state = new SqliteStateStore(dbPath);
  try {
    const registry = new ProjectRegistry({ state });
    const project = registry.register({
      rootDir: root,
      name: "Trusted plan",
      verify: [{ name: "verify", executable: process.execPath, args: ["-e", "process.stdout.write('safe')"] }],
    });
    const originalDigest = project.trustedVerificationPlan?.digest;
    assert.ok(originalDigest);
    const initialRunner = new VerificationRunner({ state, registry, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    assert.equal((await initialRunner.run(project.projectId)).ok, true);
    assert.equal(initialRunner.hasCanonicalFullPass(project.projectId), true);
    state.close();

    writeProjectConfig(root, {
      id: project.projectId,
      name: "Mutable metadata",
      verify: [{ name: "renamed", executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] }],
    });
    state = new SqliteStateStore(dbPath);
    const reopenedRegistry = new ProjectRegistry({ state });
    const reopened = reopenedRegistry.require(project.projectId);
    assert.equal(reopened.projectId, project.projectId);
    assert.equal(reopened.name, "Trusted plan");
    assert.equal(reopened.boundary.verificationPlan.status, "changed_untrusted");
    assert.equal(reopened.boundary.verificationPlan.trustedDigest, originalDigest);

    const sink = new InMemoryEventSink();
    const tracer = new Tracer({ sink });
    const runner = new VerificationRunner({ state, registry: reopenedRegistry, tracer, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    const rejected = await runner.run(project.projectId);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "VERIFICATION_PLAN_DRIFT");
    assert.equal(sink.events.some((event) => event.type === "process.started"), false);
    assert.equal(existsSync(marker), false);

    const updated = reopenedRegistry.trustVerificationPlan(project.projectId);
    assert.notEqual(updated.trustedVerificationPlan?.digest, originalDigest);
    assert.equal(updated.trustedVerificationPlan?.provenance.source, "explicit_update");
    assert.equal(updated.boundary.verificationPlan.status, "trusted");
    assert.equal(runner.hasCanonicalFullPass(project.projectId), false);
    const accepted = await runner.run(project.projectId);
    assert.equal(accepted.ok, true);
    assert.equal(existsSync(marker), true);
    if (accepted.ok) {
      assert.equal(accepted.data.executionPosture, "host_unisolated");
      assert.equal(accepted.data.trustedPlanDigest, updated.trustedVerificationPlan?.digest);
      assert.equal(accepted.data.trustedPlanProvenance.source, "explicit_update");
    }

    writeProjectConfig(root, {
      id: project.projectId,
      verify: [{ name: "description-only-change", executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] }],
    });
    assert.equal(reopenedRegistry.require(project.projectId).boundary.verificationPlan.status, "trusted");
    writeFileSync(join(root, "source.ts"), "export const changed = true;\n");
    assert.equal(reopenedRegistry.require(project.projectId).boundary.verificationPlan.status, "trusted");
    const runtime = new ProjectRuntime({ state, registry: reopenedRegistry, tracer, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    const inspected = await runtime.inspect(project.projectId);
    const resumed = await runtime.resume(project.projectId);
    assert.equal(inspected.ok && inspected.data.boundary.verificationPlan.trustedDigest, updated.trustedVerificationPlan?.digest);
    assert.equal(resumed.ok && resumed.data.boundary.execution.posture, "host_unisolated");
  } finally {
    try { state.close(); } catch { /* already closed during reopen */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("canonical identity, confined config and physical root block fabricated or drifted execution", async () => {
  const base = mkdtempSync(join(tmpdir(), "aer-fa-r3-identity-"));
  const root = join(base, "project");
  const moved = join(base, "registered-project-moved");
  const outsideConfig = join(base, "outside-project.json");
  const runtimeRoot = join(base, "runtime");
  mkdirSync(root);
  mkdirSync(runtimeRoot);
  const state = new SqliteStateStore(join(runtimeRoot, "aer.db"));
  try {
    const registry = new ProjectRegistry({ state });
    const project = registry.register({ rootDir: root, verify: [{ name: "cwd", executable: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] }] });
    const runner = new VerificationRunner({ state, registry, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });

    const fabricated = { projectId: "project_fabricated" as ProjectId, rootDir: base, root: base, config: project.config } as unknown as ProjectIdentity;
    const unknown = await runner.run(fabricated);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, "PROJECT_NOT_FOUND");

    const altered = { ...project, rootDir: base, root: base, config: { ...project.config, verify: ["false"] } };
    const canonical = await runner.run(altered);
    assert.equal(canonical.ok, true);
    if (canonical.ok) assert.equal(canonical.data.checks[0]?.stdout, root);

    writeProjectConfig(root, { id: "project_rekey_attempt", verify: project.config.verify });
    assert.equal(registry.require(project.projectId).projectId, project.projectId);
    assert.equal(registry.require(project.projectId).boundary.identity.status, "changed_untrusted");
    const identityRejected = await runner.run(project.projectId);
    assert.equal(identityRejected.ok, false);
    if (!identityRejected.ok) assert.equal(identityRejected.error.code, "PROJECT_IDENTITY_DRIFT");

    writeProjectConfig(root, { id: project.projectId, verify: project.config.verify });
    writeFileSync(outsideConfig, JSON.stringify({ version: 1, id: project.projectId, verify: project.config.verify }));
    rmSync(projectConfigPath(root));
    symlinkSync(outsideConfig, projectConfigPath(root));
    const configSymlink = registry.require(project.projectId);
    assert.equal(configSymlink.boundary.identity.code, "PROJECT_CONFIG_SYMLINK");
    assert.equal((await runner.run(project.projectId)).ok, false);

    rmSync(projectConfigPath(root));
    writeProjectConfig(root, { id: project.projectId, verify: project.config.verify });
    renameSync(root, moved);
    mkdirSync(root);
    writeProjectConfig(root, { id: project.projectId, verify: project.config.verify });
    assert.equal(registry.require(project.projectId).boundary.root.status, "changed_untrusted");
    const rootRejected = await runner.run(project.projectId);
    assert.equal(rootRejected.ok, false);
    if (!rootRejected.ok) assert.equal(rootRejected.error.code, "PROJECT_ROOT_DRIFT");

    const reconciled = registry.reconcileRoot(project.projectId, moved);
    assert.equal(reconciled.rootDir, moved);
    assert.equal(reconciled.boundary.root.status, "trusted");
    assert.equal((await runner.run(project.projectId)).ok, true);

    const movedAgain = join(base, "registered-project-moved-again");
    renameSync(moved, movedAgain);
    symlinkSync(movedAgain, moved);
    assert.equal(registry.require(project.projectId).boundary.root.code, "PROJECT_ROOT_SYMLINK");
    assert.equal((await runner.run(project.projectId)).ok, false);
  } finally {
    state.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("verification sanitizes credentials and distinguishes partial success from canonical full PASS", async () => {
  const { root, runtimeRoot, dbPath } = fixture("aer-fa-r3-posture");
  const state = new SqliteStateStore(dbPath);
  const priorSecret = process.env.GH_TOKEN;
  const priorOrdinary = process.env.AER_REQUIRED_ORDINARY;
  process.env.GH_TOKEN = "secret-sentinel";
  process.env.AER_REQUIRED_ORDINARY = "ordinary-value";
  try {
    const registry = new ProjectRegistry({ state });
    const project = registry.register({ rootDir: root, verify: [
      { name: "environment", executable: process.execPath, args: ["-e", "process.stdout.write(`${process.env.GH_TOKEN ?? 'absent'}|${process.env.AER_REQUIRED_ORDINARY ?? 'missing'}`)"] },
      { name: "second", executable: process.execPath, args: ["-e", "process.stdout.write('second')"] },
    ] });
    const runner = new VerificationRunner({ state, registry, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    const partial = await runner.run({ project: project.projectId, checkNames: ["environment"] });
    assert.equal(partial.ok, true);
    if (!partial.ok) return;
    assert.equal(partial.data.checks[0]?.stdout, "absent|ordinary-value");
    assert.equal(partial.data.coverage, "partial");
    assert.equal(partial.data.checksPassed, true);
    assert.equal(partial.data.passed, false);
    assert.equal(partial.data.canonicalPassed, false);
    assert.equal(partial.data.executionPosture, "host_unisolated");
    const durablePartial = state.getEntity("verifications", partial.data.verificationId);
    assert.equal(durablePartial?.data?.passed, false);
    assert.equal(durablePartial?.data?.coverage, "partial");
    assert.equal(durablePartial?.data?.trustedPlanDigest, project.trustedVerificationPlan?.digest);
    assert.equal(JSON.stringify(durablePartial).includes("secret-sentinel"), false);
    assert.equal(runner.hasCanonicalFullPass(project.projectId), false);

    const exceptionRunner = new VerificationRunner({ state, registry, allowedEnvironmentKeys: ["GH_TOKEN"], artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    const excepted = await exceptionRunner.run({ project: project.projectId, checkNames: ["environment"] });
    assert.equal(excepted.ok, true);
    if (excepted.ok) {
      assert.equal(excepted.data.checks[0]?.stdout, "secret-sentinel|ordinary-value");
      assert.deepEqual(excepted.data.allowedEnvironmentKeys, ["GH_TOKEN"]);
      assert.equal(JSON.stringify(state.getEntity("verifications", excepted.data.verificationId)).includes("secret-sentinel"), false);
    }

    const full = await runner.run(project.projectId);
    assert.equal(full.ok, true);
    if (full.ok) {
      assert.equal(full.data.coverage, "full");
      assert.equal(full.data.passed, true);
      assert.equal(full.data.canonicalPassed, true);
      assert.equal(full.data.executedCheckIds.length, 2);
      assert.equal(runner.hasCanonicalFullPass(project.projectId), true);
    }
  } finally {
    if (priorSecret === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorSecret;
    if (priorOrdinary === undefined) delete process.env.AER_REQUIRED_ORDINARY;
    else process.env.AER_REQUIRED_ORDINARY = priorOrdinary;
    state.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
