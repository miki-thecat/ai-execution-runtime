import { ExecutionRuntime } from './runtime.ts';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const rootPath = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
const command = args.find((arg, index) => index !== rootIndex && index !== rootIndex + 1) ?? 'inspect';
const runtime = new ExecutionRuntime({ rootPath: rootPath ?? process.cwd() });

const main = async (): Promise<void> => {
  let result: unknown;
  if (command === 'inspect') result = await runtime.inspect();
  else if (command === 'resume') result = await runtime.resume();
  else if (command === 'shell') result = await runtime.shellRun(args.slice(args.indexOf(command) + 1).join(' '));
  else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

void main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}).finally(() => runtime.close());
