import type { OperationContext } from "../core/context.ts";
import type { EffectClass } from "../core/effects.ts";
import type { RuntimeResult } from "../core/result.ts";

/** The provider-neutral unit consumed by every later surface. */
export interface Operation<Input, Output> {
  readonly name: string;
  readonly effectClass: EffectClass;
  readonly executor?: string;
  readonly provider?: string;
  execute(input: Input, context: OperationContext): RuntimeResult<Output> | Promise<RuntimeResult<Output>>;
}
