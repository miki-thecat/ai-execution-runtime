import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore } from "../src/artifacts/index.ts";
import type { ProjectId } from "../src/core/index.ts";
import { sanitizeDurableText } from "../src/observability/redaction.ts";
import { InMemoryEventSink, Tracer } from "../src/observability/index.ts";
import { projectConfigPath, ProjectRegistry, ProjectRuntime, writeProjectConfig, type ProjectIdentity } from "../src/project/index.ts";
import { SqliteStateStore } from "../src/state/index.ts";
import { AERDaemon, createSemanticOperationEnvelope, permissiveEffectPolicy } from "../src/index.ts";
import { createVerifyRunOperation, type VerificationEvidence, VerificationRunner } from "../src/verify/index.ts";

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
    const exposedCheck = project.trustedVerificationPlan?.plan.checks[0] as { args: string[] };
    exposedCheck.args[1] = "process.stdout.write('caller-mutated')";
    const initialRunner = new VerificationRunner({ state, registry, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    const initial = await initialRunner.run(project.projectId);
    assert.equal(initial.ok, true);
    if (initial.ok) {
      assert.equal(initial.data.checks[0]?.stdout, "safe");
      assert.equal(initial.data.trustedPlanDigest, originalDigest);
    }
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
  const outsideDirectory = join(base, "outside-aer");
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
    assert.throws(() => writeProjectConfig(root, { id: project.projectId, verify: project.config.verify }), /PROJECT_CONFIG_SYMLINK/);
    assert.equal(JSON.parse(readFileSync(outsideConfig, "utf8")).id, project.projectId);

    rmSync(projectConfigPath(root));
    rmSync(join(root, ".aer"), { recursive: true });
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, "project.json"), "outside-parent-sentinel\n");
    symlinkSync(outsideDirectory, join(root, ".aer"));
    assert.equal(registry.require(project.projectId).boundary.identity.code, "PROJECT_CONFIG_SYMLINK");
    assert.throws(() => writeProjectConfig(root, { id: project.projectId, verify: project.config.verify }), /PROJECT_CONFIG_SYMLINK/);
    assert.equal(readFileSync(join(outsideDirectory, "project.json"), "utf8"), "outside-parent-sentinel\n");

    rmSync(join(root, ".aer"));
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
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const priorKubeconfig = process.env.KUBECONFIG;
  const priorNpmUserconfig = process.env.NPM_CONFIG_USERCONFIG;
  process.env.GH_TOKEN = "secret-sentinel";
  process.env.AER_REQUIRED_ORDINARY = "ordinary-value";
  process.env.DATABASE_URL = "database-secret-sentinel";
  process.env.KUBECONFIG = "kube-secret-sentinel";
  process.env.NPM_CONFIG_USERCONFIG = "npm-secret-sentinel";
  try {
    const registry = new ProjectRegistry({ state });
    const project = registry.register({ rootDir: root, verify: [
      { name: "environment", executable: process.execPath, args: ["-e", "process.stdout.write(`${process.env.GH_TOKEN ?? 'absent'}|${process.env.DATABASE_URL ?? 'absent'}|${process.env.KUBECONFIG ?? 'absent'}|${process.env.NPM_CONFIG_USERCONFIG ?? 'absent'}|${process.env.AER_REQUIRED_ORDINARY ?? 'missing'}`)"] },
      { name: "second", executable: process.execPath, args: ["-e", "process.stdout.write('second')"] },
    ] });
    const runner = new VerificationRunner({ state, registry, artifacts: new FileArtifactStore(join(runtimeRoot, "artifacts")) });
    const partial = await runner.run({ project: project.projectId, checkNames: ["environment"] });
    assert.equal(partial.ok, true);
    if (!partial.ok) return;
    assert.equal(partial.data.checks[0]?.stdout, "absent|absent|absent|absent|ordinary-value");
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
      assert.equal(excepted.data.checks[0]?.stdout, "secret-sentinel|absent|absent|absent|ordinary-value");
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
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (priorKubeconfig === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = priorKubeconfig;
    if (priorNpmUserconfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = priorNpmUserconfig;
    state.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("verify.run shares its response budget across noisy passing checks and spills evidence", async () => {
  const { root, runtimeRoot, dbPath } = fixture("aer-beta41-output");
  const state = new SqliteStateStore(dbPath);
  try {
    const registry = new ProjectRegistry({ state });
    // Control characters exercise JSON expansion as well as combined streams.
    const output = "\u0001\n\"\\é".repeat(4000);
    writeFileSync(join(root, "noisy-output.txt"), output);
    const project = registry.register({
      rootDir: root,
      verify: ["typecheck", "test", "benchmark"].map((name) => ({
        name, executable: "/bin/sh",
        args: ["-c", "cat noisy-output.txt; cat noisy-output.txt >&2"],
      })),
    });
    const artifacts = new FileArtifactStore(join(runtimeRoot, "artifacts"));
    const runner = new VerificationRunner({ state, registry, artifacts });
    const daemon = new AERDaemon({ dataRoot: runtimeRoot, state, projects: registry, policy: permissiveEffectPolicy() });
    daemon.register(createVerifyRunOperation(runner));
    daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online", capabilities: { operations: ["verify.run"] } });
    const result = await daemon.execute(createSemanticOperationEnvelope({ operation: "verify.run", projectId: project.projectId, input: { project: project.projectId } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const evidence = result.data as VerificationEvidence;
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= Math.min(daemon.budgets.maxOutputBytes, daemon.budgets.maxReturnedOutputBytes));
    assert.equal(evidence.canonicalPassed, true);
    assert.equal(evidence.checksPassed, true);
    assert.equal(evidence.passed, true);
    assert.equal(evidence.status, "completed");
    assert.equal(result.meta.effectState, "applied");
    assert.equal(runner.hasCanonicalFullPass(project.projectId), true);
    assert.equal(evidence.checks.length, 3);
    for (const check of evidence.checks) {
      assert.equal(check.status, "passed");
      assert.equal(check.exitCode, 0);
      assert.equal(check.rawOutputBytes, Buffer.byteLength(output) * 2);
      assert.ok(check.returnedOutputBytes < check.rawOutputBytes);
      assert.ok(check.artifactRefs.length > 0);
      for (const ref of check.artifactRefs) {
        assert.ok(evidence.artifactRefs.includes(ref));
        assert.ok(result.meta.artifactRefs.includes(ref));
        assert.equal(Buffer.from(artifacts.read(ref, { projectId: project.projectId })).toString(), output);
      }
    }
    assert.equal(result.meta.metrics.rawOutputBytes, Buffer.byteLength(output) * 6);
    assert.equal(result.meta.metrics.returnedOutputBytes, evidence.checks.reduce((sum, check) => sum + check.returnedOutputBytes, 0));
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

for (const exitCode of [0, 1]) {
  test(`verify.run bounds oversized metadata with noisy checks (exit ${exitCode})`, async () => {
    const { root, runtimeRoot, dbPath } = fixture("aer-beta41-metadata");
    const state = new SqliteStateStore(dbPath);
    try {
      const registry = new ProjectRegistry({ state });
      const output = '\u0001\n"\\é'.repeat(4000);
      writeFileSync(join(root, "noisy-output.txt"), output);
      const names = Array.from({ length: 24 }, (_, i) => `check-${i}-${'é"\\'.repeat(1500)}`);
      const project = registry.register({ rootDir: root, verify: names.map((name) => ({
        name, executable: "/bin/sh",
        args: ["-c", `cat noisy-output.txt; cat noisy-output.txt >&2; exit ${exitCode} # ${"metadata".repeat(1000)}`],
      })) });
      const artifacts = new FileArtifactStore(join(runtimeRoot, "artifacts"));
      const runner = new VerificationRunner({ state, registry, artifacts });
      const daemon = new AERDaemon({ dataRoot: runtimeRoot, state, projects: registry, policy: permissiveEffectPolicy(), budgets: { maxOutputBytes: 8192, maxReturnedOutputBytes: 4096 } });
      daemon.register(createVerifyRunOperation(runner));
      daemon.registerDevice({ deviceId: daemon.deviceId, presence: "online", capabilities: { operations: ["verify.run"] } });
      const result = await daemon.execute(createSemanticOperationEnvelope({ operation: "verify.run", projectId: project.projectId, input: { project: project.projectId } }));
      assert.equal(result.ok, exitCode === 0, JSON.stringify(result));
      assert.ok(Buffer.byteLength(JSON.stringify(result.ok ? result.data : result.error)) <= 4096);
      assert.equal(result.meta.effectState, "applied");
      assert.equal(runner.hasCanonicalFullPass(project.projectId), exitCode === 0);
      const durable = runner.latest(project.projectId)!;
      assert.equal(durable.canonicalPassed, exitCode === 0);
      assert.equal(durable.presentation, undefined);
      assert.equal(durable.checks.length, names.length);
      assert.equal(durable.executedCheckIds.length, names.length);
      assert.ok(Buffer.byteLength(JSON.stringify(durable)) > 4096);
      for (const [i, check] of durable.checks.entries()) {
        assert.equal(check.name, sanitizeDurableText(names[i]!));
        assert.equal(check.exitCode, exitCode);
        assert.ok(check.artifactRefs.length > 0);
        for (const ref of check.artifactRefs) {
          assert.ok(durable.artifactRefs.includes(ref));
          assert.equal(Buffer.from(artifacts.read(ref, { projectId: project.projectId })).toString(), output);
        }
      }
      if (result.ok) {
        const evidence = result.data as VerificationEvidence;
        assert.deepEqual(evidence.presentation, { compacted: true, totalChecks: names.length });
        assert.equal(evidence.verificationId, durable.verificationId);
        assert.equal(evidence.trustedPlanDigest, durable.trustedPlanDigest);
        assert.equal(evidence.canonicalPassed, true);
        assert.equal(evidence.checksPassed, true);
        assert.equal(evidence.passed, true);
        assert.equal(evidence.coverage, "full");
      } else {
        assert.equal(result.error.code, "VERIFY_FAILED");
      }
    } finally {
      state.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
}
