import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOperationContext,
  createRunId,
  createTraceId,
  DirectExecutor,
  DockerSandboxProvider,
  InMemoryEventSink,
  OperationRegistry,
  permissiveEffectPolicy,
  Tracer,
} from "../src/index.ts";

function context(effectPolicy?: Parameters<typeof createOperationContext>[0]["effectPolicy"]) {
  return createOperationContext({ traceId: createTraceId(), runId: createRunId(), actor: "model", ...(effectPolicy === undefined ? {} : { effectPolicy }) });
}

test("Full Alpha policy gates high-risk effects and dispatch evidence is canonical", async () => {
  const tracer = new Tracer();
  const calls: string[] = [];
  const registry = new OperationRegistry({ tracer }).register({
    name: "fixture.remote",
    effectClass: "remote_write",
    execute() { calls.push("executed"); throw new Error("must be gated"); },
  });
  const result = await registry.execute("fixture.remote", undefined, context());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "EFFECT_APPROVAL_REQUIRED");
  assert.equal(result.meta.policyDecision, "approval_required");
  assert.equal(result.meta.policyEvidence?.source, "aer");
  assert.equal(calls.length, 0);
  assert.equal(tracer.sink instanceof InMemoryEventSink, true);
  assert.equal(tracer.sink instanceof InMemoryEventSink && tracer.sink.events[0]?.policyDecision, "approval_required");
});

test("Direct uses a safe baseline, scoped credential grants, and bounded capture", async () => {
  const priorToken = process.env.GH_TOKEN;
  const priorFixture = process.env.FA07_FIXTURE_SECRET;
  process.env.GH_TOKEN = "secret-sentinel";
  process.env.FA07_FIXTURE_SECRET = "fixture-secret-sentinel";
  const directory = mkdtempSync(join(tmpdir(), "aer-policy-test-"));
  try {
    const tracer = new Tracer();
    const executor = new DirectExecutor({ tracer, defaultMaxOutputBytes: 8, credentialClassifiers: [{ name: "fixture", pattern: /^FA07_FIXTURE_SECRET$/ }] });
    const safe = await executor.runShell({ command: "printf '%s|%s|%s' \"${GH_TOKEN:-absent}\" \"${FA07_FIXTURE_SECRET:-absent}\" \"${PATH:-missing}\"", inheritEnvironment: true }, context(permissiveEffectPolicy()));
    assert.equal(safe.ok, true);
    if (!safe.ok) return;
    assert.equal(safe.data.stdout, "absent|absent|".slice(0, 8));
    assert.equal(safe.data.environment?.withheld.some((entry) => entry.key === "GH_TOKEN"), true);
    assert.equal(safe.data.environment?.withheld.some((entry) => entry.key === "FA07_FIXTURE_SECRET"), true);
    const start = tracer.sink instanceof InMemoryEventSink ? tracer.sink.events.find((event) => event.type === "process.started") : undefined;
    assert.equal(start?.environment?.valueLogging, "disabled");
    assert.equal(JSON.stringify(tracer.sink).includes("secret-sentinel"), false);

    const granted = await executor.runShell({ command: "printf %s \"${GH_TOKEN:-absent}\"" }, context({ ...permissiveEffectPolicy(), credentialGrants: [{ key: "GH_TOKEN", operations: ["shell.run"] }] }));
    assert.equal(granted.ok, true);
    if (granted.ok) assert.equal(granted.data.stdout, "secret-s");

    const huge = await executor.runShell({ command: "printf 'x%.0s' $(seq 1 200000)" }, context(permissiveEffectPolicy()));
    assert.equal(huge.ok, true);
    if (huge.ok) {
      assert.equal(huge.data.stdout.length, 8);
      assert.equal(huge.data.truncated, true);
      assert.equal(huge.data.capturedOutputBytes <= 1 * 1024 * 1024, true);
      assert.equal(huge.data.discardedOutputBytes, 0);
      assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith(`aer-direct-${huge.data.processId}-`)).length, 0);
    }
  } finally {
    if (priorToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = priorToken;
    if (priorFixture === undefined) delete process.env.FA07_FIXTURE_SECRET; else process.env.FA07_FIXTURE_SECRET = priorFixture;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sbx detection is headless and represents unavailable, setup-required, and ready", async () => {
  const unavailable = new DockerSandboxProvider({ cli: { run: () => ({ stdout: "", stderr: "ENOENT", exitCode: 127 }) } });
  assert.equal((await unavailable.capabilities()).state, "unavailable");

  const setup = new DockerSandboxProvider({ cli: { run: (args) => args[0] === "--version" ? { stdout: "sbx 1", stderr: "", exitCode: 0 } : { stdout: "", stderr: "policy setup required", exitCode: 1 } } });
  const setupCapabilities = await setup.capabilities();
  assert.equal(setupCapabilities.state, "available_requires_setup");
  assert.match(setupCapabilities.setupAction ?? "", /sbx setup/);

  const calls: string[][] = [];
  const ready = new DockerSandboxProvider({ cli: { run: (args) => { calls.push([...args]); return args[0] === "--version" || args[0] === "ls" ? { stdout: "sbx", stderr: "", exitCode: 0 } : { stdout: "ok", stderr: "", exitCode: 0 }; } } });
  const capabilities = await ready.capabilities();
  assert.equal(capabilities.state, "ready");
  assert.equal(capabilities.workspaceModes.includes("private_clone"), true);
  const result = await ready.execute({ executable: "true", effectClass: "read", workspaceMode: "private_clone", timeoutMs: 10_000, maxOutputBytes: 1_000_000 }, context(permissiveEffectPolicy()));
  assert.equal(result.ok, true);
  assert.equal(calls.some((args) => args[0] === "run" && args.includes("--non-interactive")), true);
});
