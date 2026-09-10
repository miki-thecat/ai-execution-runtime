import type { RuntimeEvent } from "../observability/events.ts";
import type { StateStore } from "../state/store.ts";
import type { RuntimeStatus } from "../core/result.ts";

export interface VerificationMetricSummary {
  readonly attempts: number;
  readonly passed: boolean;
  readonly canonicalPassed: boolean;
  readonly statuses: readonly string[];
  readonly coverage: "full" | "partial" | "mixed" | "unknown";
}

export interface DelegatedMetricSummary {
  readonly runs: number;
  readonly completed: number;
  readonly tokens: {
    readonly input?: number;
    readonly output?: number;
    readonly cached?: number;
  };
  readonly tokenInput?: number;
  readonly tokenOutput?: number;
  readonly tokenCached?: number;
  readonly isolation: readonly {
    readonly userConfig?: string;
    readonly execPolicy?: string;
  }[];
}

/** Metrics intentionally use both semantic names and compact aliases. */
export interface RunMetricSummary {
  readonly runId: string;
  readonly status: RuntimeStatus;
  readonly durationMs: number;
  readonly modelFacingOperations: number;
  readonly modelOperations: number;
  readonly internalCalls: number;
  readonly pollCountModel: number;
  readonly modelPolling: number;
  readonly pollCountInternal: number;
  readonly internalPolling: number;
  readonly rawOutputBytes: number;
  readonly rawBytes: number;
  readonly returnedOutputBytes: number;
  readonly returnedBytes: number;
  readonly compressionRatio: number;
  readonly retries: number;
  readonly filesChanged: number;
  readonly verification: VerificationMetricSummary;
  readonly delegated: DelegatedMetricSummary;
  readonly delegatedTokens: DelegatedMetricSummary["tokens"];
}

export interface RunComparison {
  readonly runs: readonly RunMetricSummary[];
  readonly delta?: Readonly<Record<string, number>>;
}

const TERMINAL_OPERATION_EVENTS = new Set<RuntimeEvent["type"]>([
  "operation.completed",
  "operation.failed",
  "operation.cancelled",
  "operation.unknown",
]);

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function optionalSum(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : sum(present);
}

function statusFor(runId: string, events: readonly RuntimeEvent[], state: StateStore | undefined): RuntimeStatus {
  const durable = state?.getRun(runId as import("../core/ids.ts").RunId);
  if (durable !== undefined) return durable.status;
  const terminal = [...events].reverse().find((event) => event.type.startsWith("run.") && event.status !== "running");
  if (terminal?.status !== undefined) return terminal.status;
  const operation = [...events].reverse().find((event) => TERMINAL_OPERATION_EVENTS.has(event.type));
  return operation?.status ?? "unknown";
}

function operationEvents(events: readonly RuntimeEvent[]): readonly RuntimeEvent[] {
  // A semantic operation is the aggregation boundary. Provider/process and
  // nested operation spans carry useful evidence, but adding them again would
  // count one model request as several model requests.
  const starts = events.filter((event) => event.type === "operation.started");
  const operationSpans = new Set(starts.map((event) => event.spanId));
  const topLevelStarts = starts.filter((event) => event.parentSpanId === undefined || !operationSpans.has(event.parentSpanId));
  const terminal = events.filter((event) => TERMINAL_OPERATION_EVENTS.has(event.type) && (event.parentSpanId === undefined || !operationSpans.has(event.parentSpanId)));
  const terminalSpans = new Set(terminal.map((event) => event.spanId));
  // An interrupted process can leave only operation.started durable. Count
  // that attempted model-facing operation with zero terminal measurements.
  return [...terminal, ...topLevelStarts.filter((event) => !terminalSpans.has(event.spanId))];
}

function verificationSummary(runId: string, state: StateStore | undefined): VerificationMetricSummary {
  const entities = state?.listEntities("verifications", { runId, order: "asc" }) ?? [];
  const records = entities.map((entity) => entity.data ?? {});
  const statuses = entities.map((entity) => entity.status ?? "unknown");
  const coverageValues = records.map((record) => record.coverage).filter((value): value is string => typeof value === "string");
  const coverage = coverageValues.length === 0
    ? "unknown"
    : new Set(coverageValues).size > 1
      ? "mixed"
      : coverageValues[0] === "full" || coverageValues[0] === "partial" ? coverageValues[0] : "unknown";
  return {
    attempts: entities.length,
    passed: records.some((record) => record.passed === true || record.checksPassed === true),
    canonicalPassed: records.some((record) => record.canonicalPassed === true),
    statuses: [...new Set(statuses)],
    coverage,
  };
}

function delegatedSummary(runId: string, state: StateStore | undefined): DelegatedMetricSummary {
  const entities = state?.listEntities("agent_runs", { runId, order: "asc" }) ?? [];
  const records = entities.map((entity) => entity.data ?? {});
  const metrics = records.map((record) => record.metrics).filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value));
  const usage = metrics.map((metric) => metric.usage).filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value));
  const input = optionalSum(usage.map((value) => typeof value.inputTokens === "number" ? value.inputTokens : undefined));
  const output = optionalSum(usage.map((value) => typeof value.outputTokens === "number" ? value.outputTokens : undefined));
  const cached = optionalSum(usage.map((value) => typeof value.cachedInputTokens === "number" ? value.cachedInputTokens : undefined));
  const isolation = records.map((record) => {
    const posture = record.capabilityPosture;
    if (posture === null || typeof posture !== "object" || Array.isArray(posture)) return {};
    const value = posture as Record<string, unknown>;
    return {
      ...(typeof value.userConfig === "string" ? { userConfig: value.userConfig } : {}),
      ...(typeof value.execPolicy === "string" ? { execPolicy: value.execPolicy } : {}),
    };
  });
  const completed = entities.filter((entity) => entity.status === "completed").length;
  return {
    runs: entities.length,
    completed,
    tokens: {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(cached === undefined ? {} : { cached }),
    },
    ...(input === undefined ? {} : { tokenInput: input }),
    ...(output === undefined ? {} : { tokenOutput: output }),
    ...(cached === undefined ? {} : { tokenCached: cached }),
    isolation,
  };
}

export function summarizeRun(runId: string, events: readonly RuntimeEvent[], state?: StateStore): RunMetricSummary {
  const operations = operationEvents(events);
  const run = state?.getRun(runId as import("../core/ids.ts").RunId);
  const start = run?.startedAt ?? events.find((event) => event.type === "run.started")?.timestamp;
  const end = run?.completedAt ?? [...events].reverse().find((event) => event.type.startsWith("run.") && event.type !== "run.started")?.timestamp;
  const durationMs = start !== undefined && end !== undefined ? Math.max(0, Date.parse(end) - Date.parse(start)) : sum(operations.map((event) => event.durationMs));
  const delegated = delegatedSummary(runId, state);
  const verification = verificationSummary(runId, state);
  const rawOutputBytes = sum(operations.map((event) => event.rawOutputBytes));
  const returnedOutputBytes = sum(operations.map((event) => event.returnedOutputBytes));
  const values = {
    runId,
    status: statusFor(runId, events, state),
    durationMs,
    modelFacingOperations: operations.length,
    modelOperations: operations.length,
    internalCalls: sum(operations.map((event) => event.internalCalls)),
    pollCountModel: sum(operations.map((event) => event.pollCountModel)),
    modelPolling: sum(operations.map((event) => event.pollCountModel)),
    pollCountInternal: sum(operations.map((event) => event.pollCountInternal)),
    internalPolling: sum(operations.map((event) => event.pollCountInternal)),
    rawOutputBytes,
    rawBytes: rawOutputBytes,
    returnedOutputBytes,
    returnedBytes: returnedOutputBytes,
    compressionRatio: rawOutputBytes / Math.max(returnedOutputBytes, 1),
    retries: sum(operations.map((event) => event.retries)),
    filesChanged: sum(operations.map((event) => event.filesChanged)),
    verification,
    delegated,
    delegatedTokens: delegated.tokens,
  } satisfies RunMetricSummary;
  return values;
}

export function compareRuns(runIds: readonly string[], state: StateStore): RunComparison {
  const runs = runIds.map((runId) => summarizeRun(runId, state.listEvents({ runId: runId as import("../core/ids.ts").RunId, limit: 10_000 }), state));
  const first = runs[0];
  const second = runs[1];
  if (first === undefined || second === undefined) return { runs };
  const delta = {
    durationMs: second.durationMs - first.durationMs,
    modelFacingOperations: second.modelFacingOperations - first.modelFacingOperations,
    internalCalls: second.internalCalls - first.internalCalls,
    pollCountModel: second.pollCountModel - first.pollCountModel,
    pollCountInternal: second.pollCountInternal - first.pollCountInternal,
    rawOutputBytes: second.rawOutputBytes - first.rawOutputBytes,
    returnedOutputBytes: second.returnedOutputBytes - first.returnedOutputBytes,
    retries: second.retries - first.retries,
    filesChanged: second.filesChanged - first.filesChanged,
  };
  return { runs, delta };
}

export const aggregateRunMetrics = summarizeRun;
