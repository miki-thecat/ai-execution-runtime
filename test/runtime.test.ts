import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRuntime } from '../src/runtime.ts';

const runtimes: ExecutionRuntime[] = [];
const childProcessesAvailable = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).error === undefined;
const childOutputAvailable = childProcessesAvailable && spawnSync(process.execPath, ['-e', "process.stdout.write('probe')"], { encoding: 'utf8' }).stdout === 'probe';
let fixtureGitAvailable = false;

const fixture = (): { root: string; gitAvailable: boolean } => {
  const root = mkdtempSync(join(tmpdir(), 'ai-runtime-alpha-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'fixture.txt'), 'before\nkeep\n', 'utf8');
  if (childProcessesAvailable) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      fixtureGitAvailable = true;
    } catch {
      fixtureGitAvailable = false;
    }
  }
  return { root, gitAvailable: fixtureGitAvailable };
};

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()?.close();
});

describe('Full Alpha vertical slice', () => {
  it('runs, persists, patches, searches, verifies and resumes a fixture project', async () => {
    const fixtureProject = fixture();
    const root = fixtureProject.root;
    const runtime = new ExecutionRuntime({ rootPath: root });
    runtimes.push(runtime);
    runtime.createTask('alpha fixture');
    runtime.addDecision('Use direct execution as the first-class path.');

    const shell = await runtime.shellRun(`${process.execPath} -e "process.stdout.write('hello')"`);
    if (childProcessesAvailable) {
      assert.equal(shell.ok, true);
      if (shell.ok) {
        assert.equal(shell.value.exitCode, 0);
        if (childOutputAvailable) assert.equal(shell.value.stdout, 'hello');
      }

      const large = await runtime.shellRun(`${process.execPath} -e "process.stdout.write('x'.repeat(100))"`, { maxOutputBytes: 32, artifactThresholdBytes: 16 });
      assert.equal(large.ok, true);
      if (large.ok && childOutputAvailable) {
        assert.equal(large.value.stdout.length, 32);
        assert.equal(large.value.stdoutTruncated, true);
        assert.equal(large.value.artifactRefs.length, 1);
      }
    } else {
      assert.equal(shell.ok, false);
    }

    const patch = runtime.filePatch('--- a/src/fixture.txt\n+++ b/src/fixture.txt\n@@ -1,2 +1,2 @@\n-before\n+after\n keep\n');
    assert.equal(patch.ok, true);
    assert.equal(readFileSync(join(root, 'src', 'fixture.txt'), 'utf8'), 'after\nkeep\n');

    const search = await runtime.search('after', { cwd: 'src' });
    assert.equal(search.ok, true);
    if (search.ok) assert.equal(search.value[0]?.line, 1);

    const verification = await runtime.verify([{ name: 'fixture-check', command: process.execPath, args: ['-e', "process.exit(0)"] }]);
    assert.equal(verification.ok, true);
    if (verification.ok) assert.equal(verification.value.passed, true);

    const inspection = await runtime.inspect();
    assert.equal(inspection.ok, true);
    if (inspection.ok) {
      assert.equal(inspection.value.project.rootPath, root);
      assert.equal(inspection.value.git.available, fixtureProject.gitAvailable);
      assert.ok(inspection.value.recentEvents.length >= 6);
      assert.ok(inspection.value.recentArtifacts.length >= (childOutputAvailable ? 2 : 1));
    }

    const resumed = await runtime.resume();
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.equal(resumed.value.recentDecisions[0]?.summary, 'Use direct execution as the first-class path.');
  });

  it('supports a bounded long-running process lifecycle', async (testContext) => {
    if (!childProcessesAvailable) testContext.skip('nested child processes are blocked by this test sandbox');
    const runtime = new ExecutionRuntime({ rootPath: fixture().root });
    runtimes.push(runtime);
    const started = runtime.processStart(`${process.execPath} -e "setTimeout(() => process.stdout.write('done'), 20)"`);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const waited = await runtime.processWait(started.value.processId);
    assert.equal(waited.ok, true);
    if (waited.ok) {
      assert.equal(waited.value.exitCode, 0);
      if (childOutputAvailable) assert.equal(waited.value.stdout, 'done');
    }
  });
});
