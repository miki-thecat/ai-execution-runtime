import type { MetricsHooks, MetricsSnapshot } from './types.ts';

export class InMemoryMetrics implements MetricsHooks {
  private readonly values: MetricsSnapshot = {
    toolCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    durationMs: 0,
    pollingCalls: 0,
    retries: 0,
    outputBytes: 0,
  };

  recordToolCall(input: { durationMs: number; success: boolean; outputBytes: number; polling?: boolean; retries?: number }): void {
    this.values.toolCalls += 1;
    this.values.durationMs += input.durationMs;
    this.values.outputBytes += input.outputBytes;
    this.values.retries += input.retries ?? 0;
    if (input.polling === true) this.values.pollingCalls += 1;
    if (input.success) this.values.successfulCalls += 1;
    else this.values.failedCalls += 1;
  }

  snapshot(): MetricsSnapshot {
    return { ...this.values };
  }
}
