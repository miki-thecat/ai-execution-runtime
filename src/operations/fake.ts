import type { OperationContext } from "../core/context.ts";
import {
  createOperationMeta,
  createRuntimeError,
  runtimeFailure,
  runtimeSuccess,
  type RuntimeResult,
} from "../core/index.ts";
import type { Operation } from "./operation.ts";

export interface FakeOperationInput {
  readonly value: string;
  readonly fail?: boolean;
}

export interface FakeOperationOutput {
  readonly value: string;
  readonly summary: string;
  readonly truncated: false;
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** A provider-free operation used by the foundation contract smoke test. */
export function createFakeOperation(): Operation<FakeOperationInput, FakeOperationOutput> {
  return {
    name: "fake.echo",
    effectClass: "read",
    executor: "runtime-test",
    provider: "fake",
    execute(input: FakeOperationInput, context: OperationContext): RuntimeResult<FakeOperationOutput> {
      const rawBytes = byteLength(input.value);
      const meta = (status: "completed" | "failed") => createOperationMeta({
        context,
        operation: "fake.echo",
        status,
        effectClass: "read",
        metrics: {
          internalCalls: 1,
          rawOutputBytes: rawBytes,
          returnedOutputBytes: rawBytes,
        },
        summary: input.fail ? "fake operation failed" : "echoed one bounded value",
        truncated: false,
        executor: "runtime-test",
        provider: "fake",
      });

      if (input.fail) {
        const error = createRuntimeError({
          code: "FAKE_OPERATION_FAILED",
          message: "The fake operation was asked to fail",
          retryable: false,
          effect: "none",
        });
        return runtimeFailure(error, meta("failed"));
      }

      return runtimeSuccess(
        { value: input.value, summary: "echoed one bounded value", truncated: false },
        meta("completed"),
      );
    },
  };
}
