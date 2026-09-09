import type { OperationContext } from "../core/context.ts";
import type { Operation } from "../operations/operation.ts";
import type { SandboxExecutionRequest, SandboxExecutionResult, SandboxProvider } from "./types.ts";

/** Raw sandbox execution is conservatively declared high-risk at dispatch. */
export function createSandboxRunOperation(provider: SandboxProvider): Operation<SandboxExecutionRequest, SandboxExecutionResult> {
  return {
    name: "sandbox.run",
    effectClass: "destructive",
    executor: "sandbox",
    provider: provider.name,
    execute(input, context: OperationContext) {
      return provider.execute(input, context);
    },
  };
}

export const createSandboxExecutionOperation = createSandboxRunOperation;
