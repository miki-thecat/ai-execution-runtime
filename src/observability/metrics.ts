import {
  emptyOperationMeasurements,
  type OperationMeasurements,
} from "../core/result.ts";

export type MetricCounter =
  | "internalCalls"
  | "retries"
  | "pollCountInternal"
  | "pollCountModel"
  | "inputBytes"
  | "rawOutputBytes"
  | "returnedOutputBytes"
  | "artifactBytes"
  | "filesRead"
  | "filesChanged"
  | "tokenInput"
  | "tokenOutput"
  | "tokenCached";

const COUNTERS: readonly MetricCounter[] = [
  "internalCalls",
  "retries",
  "pollCountInternal",
  "pollCountModel",
  "inputBytes",
  "rawOutputBytes",
  "returnedOutputBytes",
  "artifactBytes",
  "filesRead",
  "filesChanged",
  "tokenInput",
  "tokenOutput",
  "tokenCached",
];

function assertMeasurement(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
}

export class MetricsAccumulator {
  private values: OperationMeasurements = emptyOperationMeasurements();

  increment(name: MetricCounter, amount = 1): this {
    assertMeasurement(amount, name);
    this.values = { ...this.values, [name]: (this.values[name] ?? 0) + amount };
    return this;
  }

  record(values: Partial<OperationMeasurements>): this {
    for (const name of COUNTERS) {
      const value = values[name];
      if (value !== undefined) {
        assertMeasurement(value, name);
        this.values = { ...this.values, [name]: (this.values[name] ?? 0) + value };
      }
    }

    if (values.durationMs !== undefined) {
      assertMeasurement(values.durationMs, "durationMs");
      this.values = { ...this.values, durationMs: values.durationMs };
    }
    if (values.exitCode !== undefined) this.setExitCode(values.exitCode);
    if (values.signal !== undefined) this.setSignal(values.signal);
    return this;
  }

  setDuration(durationMs: number): this {
    assertMeasurement(durationMs, "durationMs");
    this.values = { ...this.values, durationMs };
    return this;
  }

  /** Replace a previously accumulated snapshot, useful when importing provider totals. */
  set(values: Partial<OperationMeasurements>): this {
    for (const name of COUNTERS) {
      const value = values[name];
      if (value !== undefined) {
        assertMeasurement(value, name);
        this.values = { ...this.values, [name]: value };
      }
    }
    if (values.durationMs !== undefined) this.setDuration(values.durationMs);
    if (values.exitCode !== undefined) this.setExitCode(values.exitCode);
    if (values.signal !== undefined) this.setSignal(values.signal);
    return this;
  }

  setExitCode(exitCode: number): this {
    if (!Number.isInteger(exitCode)) throw new RangeError("exitCode must be an integer");
    this.values = { ...this.values, exitCode };
    return this;
  }

  setSignal(signal: string): this {
    this.values = { ...this.values, signal };
    return this;
  }

  merge(other: MetricsAccumulator | OperationMeasurements): this {
    return this.record(other instanceof MetricsAccumulator ? other.snapshot() : other);
  }

  snapshot(): OperationMeasurements {
    const compressionRatio =
      this.values.rawOutputBytes / Math.max(this.values.returnedOutputBytes, 1);
    return Object.freeze({ ...this.values, compressionRatio });
  }
}
