/** Runtime-owned limits. Callers may narrow these values, never raise them. */
export interface RuntimeBudgets {
  readonly maxExecutionMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxRawOutputBytes: number;
  readonly maxReturnedOutputBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxFileReadBytes: number;
  readonly maxSearchResults: number;
}

export const DEFAULT_RUNTIME_BUDGETS: RuntimeBudgets = Object.freeze({
  maxExecutionMs: 10 * 60 * 1_000,
  maxInputBytes: 128 * 1024,
  maxOutputBytes: 16 * 1024,
  maxRawOutputBytes: 1 * 1024 * 1024,
  maxReturnedOutputBytes: 64 * 1024,
  maxArtifactBytes: 1 * 1024 * 1024,
  maxFileReadBytes: 64 * 1024,
  maxSearchResults: 100,
});

export type RuntimeBudgetOverrides = Partial<RuntimeBudgets>;

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

export function resolveRuntimeBudgets(overrides?: RuntimeBudgetOverrides): RuntimeBudgets {
  const result = { ...DEFAULT_RUNTIME_BUDGETS };
  for (const key of Object.keys(result) as (keyof RuntimeBudgets)[]) {
    const value = overrides?.[key];
    if (value !== undefined) result[key] = Math.min(positive(value, key), DEFAULT_RUNTIME_BUDGETS[key]);
  }
  return Object.freeze(result);
}

/** A caller limit is an additional lower bound on a runtime-owned ceiling. */
export function narrowBudget(value: number | undefined, ceiling: number, name: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return Math.min(value, ceiling);
}

export function budgetEvidence(budgets: RuntimeBudgets): Readonly<Record<string, number>> {
  return { ...budgets };
}
