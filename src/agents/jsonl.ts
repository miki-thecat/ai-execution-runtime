import type { AgentTerminalState, AgentUsage, ParsedCodexEvent, ParsedCodexJsonl } from "./types.ts";

const KNOWN_EVENT_TYPES = new Set([
  "thread.started", "thread.completed", "thread.failed", "thread.cancelled",
  "turn.started", "turn.completed", "turn.failed", "turn.cancelled",
  "item.started", "item.updated", "item.completed", "item.failed", "item.error",
  "error", "usage",
]);

const TERMINAL_TYPES = new Set(["thread.completed", "thread.failed", "thread.cancelled", "turn.completed", "turn.failed", "turn.cancelled", "item.failed", "item.error", "error"]);
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_EVENT_LIMIT = 10_000;

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFrom(value: unknown): AgentUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = numberValue(record.input_tokens ?? record.inputTokens);
  const outputTokens = numberValue(record.output_tokens ?? record.outputTokens);
  const cachedInputTokens = numberValue(record.cached_input_tokens ?? record.cachedInputTokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function appendBounded(current: string, addition: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (current.length === 0 && new TextEncoder().encode(addition).byteLength <= maxBytes) return addition;
  const candidate = current.length === 0 ? addition : `${current}\n${addition}`;
  const bytes = new TextEncoder().encode(candidate);
  if (bytes.byteLength <= maxBytes) return candidate;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function eventType(value: Readonly<Record<string, unknown>>): string | undefined {
  return textValue(value.type);
}

function nestedRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function itemText(event: Readonly<Record<string, unknown>>): string | undefined {
  const item = nestedRecord(event.item);
  if (item === undefined) return undefined;
  const itemType = textValue(item.type);
  if (itemType !== "agent_message" && itemType !== "assistant_message" && itemType !== "message") return undefined;
  return textValue(item.text) ?? textValue(item.message) ?? textValue(event.text);
}

function itemType(event: Readonly<Record<string, unknown>>): string | undefined {
  const item = nestedRecord(event.item);
  return textValue(item?.type) ?? textValue(event.item_type) ?? textValue(event.itemType);
}

function eventUsage(event: Readonly<Record<string, unknown>>): AgentUsage | undefined {
  return usageFrom(event.usage) ?? usageFrom(event.total_usage) ?? (event.type === "usage" ? usageFrom(event) : undefined);
}

/** Incremental JSONL decoder. A chunk may split both UTF-8 sequences and lines. */
export class CodexJsonlParser {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private lineNumber = 0;
  private readonly events: ParsedCodexEvent[] = [];
  private readonly unknown = new Set<string>();
  private malformedLines = 0;
  private readonly outputParts: string[] = [];
  private outputBytes = 0;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private usage: AgentUsage | undefined;
  private commandCount = 0;
  private toolCallCount = 0;
  private readonly countedItems = new Set<string>();
  private turnStarts = 0;
  private readonly terminals: string[] = [];
  private finished = false;
  private readonly maxOutputBytes: number;
  private readonly maxEvents: number;

  constructor(maxOutputBytes = DEFAULT_OUTPUT_BYTES, maxEvents = DEFAULT_EVENT_LIMIT) {
    this.maxOutputBytes = maxOutputBytes;
    this.maxEvents = maxEvents;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw new RangeError("maxOutputBytes must be a non-negative integer");
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new RangeError("maxEvents must be a positive integer");
  }

  push(chunk: Uint8Array | string): readonly ParsedCodexEvent[] {
    if (this.finished) throw new Error("Cannot push after JSONL parser has finished");
    this.pending += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const newEvents: ParsedCodexEvent[] = [];
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      this.lineNumber += 1;
      const parsed = this.parseLine(line);
      if (parsed !== undefined) newEvents.push(parsed);
      newline = this.pending.indexOf("\n");
    }
    return newEvents;
  }

  finish(): ParsedCodexJsonl {
    if (!this.finished) {
      this.pending += this.decoder.decode();
      if (this.pending.length > 0) {
        this.lineNumber += 1;
        this.parseLine(this.pending.replace(/\r$/, ""));
      }
      this.pending = "";
      this.finished = true;
    }
    const terminalTypes = [...new Set(this.terminals)];
    const terminalClasses = [...new Set(terminalTypes.map((type) =>
      type === "thread.completed" || type === "turn.completed" ? "completed" :
        type === "thread.cancelled" || type === "turn.cancelled" ? "cancelled" : "failed"))];
    let terminalState: AgentTerminalState = "incomplete";
    if (terminalClasses.length > 1) terminalState = "contradictory";
    else if (terminalClasses[0] === "completed") terminalState = "completed";
    else if (terminalClasses[0] === "failed") terminalState = "failed";
    else if (terminalClasses[0] === "cancelled") terminalState = "cancelled";
    return {
      events: [...this.events],
      unknownEventTypes: [...this.unknown],
      malformedLines: this.malformedLines,
      ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
      ...(this.turnId === undefined ? {} : { turnId: this.turnId }),
      output: this.outputParts.join(""),
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      commandCount: this.commandCount,
      toolCallCount: this.toolCallCount,
      retries: Math.max(0, this.turnStarts - 1),
      terminalState,
      terminalTypes,
    };
  }

  private parseLine(line: string): ParsedCodexEvent | undefined {
    if (line.trim() === "") return undefined;
    let value: unknown;
    try { value = JSON.parse(line) as unknown; }
    catch { this.malformedLines += 1; return undefined; }
    const record = nestedRecord(value);
    const type = record === undefined ? undefined : eventType(record);
    if (record === undefined || type === undefined) {
      this.malformedLines += 1;
      return undefined;
    }
    const event: ParsedCodexEvent = { type, value: record, line: this.lineNumber };
    if (this.events.length < this.maxEvents) this.events.push(event);
    if (!KNOWN_EVENT_TYPES.has(type)) this.unknown.add(type);
    const thread = textValue(record.thread_id) ?? textValue(nestedRecord(record.thread)?.id);
    const turn = textValue(record.turn_id) ?? textValue(nestedRecord(record.turn)?.id);
    if (thread !== undefined) this.threadId = thread;
    if (turn !== undefined) this.turnId = turn;
    if (type === "turn.started") this.turnStarts += 1;
    if (TERMINAL_TYPES.has(type)) this.terminals.push(type);
    const usage = eventUsage(record);
    if (usage !== undefined) this.usage = usage;
    const text = itemText(record);
    if (text !== undefined && this.outputBytes < this.maxOutputBytes) {
      const next = appendBounded(this.outputParts.join(""), text, this.maxOutputBytes);
      this.outputParts.length = 0;
      this.outputParts.push(next);
      this.outputBytes = new TextEncoder().encode(next).byteLength;
    }
    const typeOfItem = itemType(record);
    const item = nestedRecord(record.item);
    const itemId = textValue(item?.id) ?? textValue(item?.command) ?? textValue(item?.name) ?? `${typeOfItem ?? "item"}`;
    if (typeOfItem === "command_execution" || typeOfItem === "shell_command" || typeOfItem === "command") {
      const key = `command:${itemId}`;
      if (!this.countedItems.has(key)) { this.countedItems.add(key); this.commandCount += 1; }
    }
    if (typeOfItem?.includes("tool") || typeOfItem === "function_call" || typeOfItem === "web_search" || typeOfItem === "computer_use" || typeOfItem === "browser") {
      const key = `tool:${itemId}`;
      if (!this.countedItems.has(key)) { this.countedItems.add(key); this.toolCallCount += 1; }
    }
    return event;
  }
}

export function parseCodexJsonl(input: Uint8Array | string, maxOutputBytes = DEFAULT_OUTPUT_BYTES): ParsedCodexJsonl {
  const parser = new CodexJsonlParser(maxOutputBytes);
  parser.push(input);
  return parser.finish();
}

export const knownCodexEventTypes = (): readonly string[] => [...KNOWN_EVENT_TYPES];
