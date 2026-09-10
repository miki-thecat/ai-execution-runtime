#!/usr/bin/env node
import { runFullAlphaScenario } from "../src/benchmark/index.ts";

try {
  const result = await runFullAlphaScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Full Alpha scenario failed"}\n`);
  process.exitCode = 1;
}
