import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionRuntime } from '../src/runtime.ts';

const root = mkdtempSync(join(tmpdir(), 'ai-runtime-demo-'));
writeFileSync(join(root, 'demo.txt'), 'hello\n', 'utf8');
const runtime = new ExecutionRuntime({ rootPath: root });

const main = async (): Promise<void> => {
  const inspection = await runtime.inspect();
  const command = await runtime.shellRun(`${process.execPath} -e "process.stdout.write('Full Alpha')"`);
  const verification = await runtime.verify([{ command: process.execPath, args: ['-e', "process.exit(0)"] }]);
  process.stdout.write(`${JSON.stringify({ root, inspection, command, verification, metrics: runtime.metrics.snapshot() }, null, 2)}\n`);
};

void main().finally(() => runtime.close());
