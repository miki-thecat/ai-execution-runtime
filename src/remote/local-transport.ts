import { createConnection, createServer, type Server, type Socket, type SocketError } from "node:net";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import type { LocalControlRequest, LocalControlResponse } from "./contracts.ts";

export const DEFAULT_LOCAL_FRAME_BYTES = 256 * 1024;
export const DEFAULT_LOCAL_CALL_TIMEOUT_MS = 30_000;

export class LocalTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalTransportError";
    this.code = code;
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function frameBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encode(value: unknown, maxBytes: number): string {
  let json: string;
  try { json = JSON.stringify(value); }
  catch { throw new LocalTransportError("CONTROL_MESSAGE_INVALID", "Control message is not JSON serializable"); }
  if (json === undefined || frameBytes(json) > maxBytes) throw new LocalTransportError("CONTROL_MESSAGE_TOO_LARGE", "Control message exceeds the local frame budget");
  return `${json}\n`;
}

function decode(line: string): unknown {
  try { return JSON.parse(line) as unknown; }
  catch { throw new LocalTransportError("CONTROL_MESSAGE_INVALID", "Control message is not valid JSON"); }
}

function writeResponse(socket: Socket, value: unknown, maxBytes: number): void {
  try { socket.end(encode(value, maxBytes)); }
  catch (error) {
    socket.end(encode({ type: "error", error: { code: error instanceof LocalTransportError ? error.code : "CONTROL_RESPONSE_INVALID", message: "Control response could not be encoded" } }, maxBytes));
  }
}

export interface LocalControlServerOptions {
  readonly endpoint: string;
  readonly maxFrameBytes?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly handle: (request: LocalControlRequest) => Promise<unknown> | unknown;
}

/** Small request/response IPC seam. It intentionally has no cloud or HTTP mode. */
export class LocalControlServer {
  readonly endpoint: string;
  readonly maxFrameBytes: number;
  readonly maxResponseBytes: number;
  private readonly handle: LocalControlServerOptions["handle"];
  private readonly server: Server;
  private started = false;

  constructor(options: LocalControlServerOptions) {
    this.endpoint = options.endpoint;
    this.maxFrameBytes = options.maxRequestBytes ?? options.maxFrameBytes ?? DEFAULT_LOCAL_FRAME_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? options.maxFrameBytes ?? DEFAULT_LOCAL_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1) throw new RangeError("maxFrameBytes must be a positive integer");
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new RangeError("maxResponseBytes must be a positive integer");
    this.handle = options.handle;
    this.server = createServer((socket) => this.accept(socket));
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onError = (error: SocketError): void => { this.server.close(); reject(error); };
      this.server.on("error", onError);
      this.server.listen(this.endpoint, () => {
        this.started = true;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    if (!this.started) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        this.started = false;
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      if (frameBytes(buffer) > this.maxFrameBytes) {
        handled = true;
        writeResponse(socket, { type: "error", error: { code: "CONTROL_MESSAGE_TOO_LARGE", message: "Control message exceeds the local frame budget" } }, this.maxResponseBytes);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffer.slice(0, newline);
      try {
        const request = decode(line) as LocalControlRequest;
        Promise.resolve(this.handle(request)).then(
          (value) => writeResponse(socket, { type: "response", value } satisfies LocalControlResponse, this.maxResponseBytes),
          (error: unknown) => writeResponse(socket, { type: "error", error: { code: errorCode(error) ?? "CONTROL_REQUEST_FAILED", message: error instanceof Error ? error.message : "Control request failed" } } satisfies LocalControlResponse, this.maxResponseBytes),
        );
      } catch (error) {
        writeResponse(socket, { type: "error", error: { code: errorCode(error) ?? "CONTROL_MESSAGE_INVALID", message: error instanceof Error ? error.message : "Control message is invalid" } } satisfies LocalControlResponse, this.maxResponseBytes);
      }
    });
  }
}

export interface LocalControlClientOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
}

export class LocalControlClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly maxFrameBytes: number;

  constructor(options: LocalControlClientOptions | string) {
    const normalized = typeof options === "string" ? { endpoint: options } : options;
    this.endpoint = normalized.endpoint;
    this.timeoutMs = normalized.timeoutMs ?? DEFAULT_LOCAL_CALL_TIMEOUT_MS;
    this.maxFrameBytes = normalized.maxFrameBytes ?? DEFAULT_LOCAL_FRAME_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
  }

  async request<T = unknown>(request: LocalControlRequest): Promise<T> {
    const message = encode(request, this.maxFrameBytes);
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.endpoint);
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => finish(new LocalTransportError("CONTROL_TIMEOUT", "Local daemon did not respond before the control timeout")), this.timeoutMs);
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error === undefined) resolve(value as T);
        else reject(error);
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(message));
      socket.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        if (frameBytes(buffer) > this.maxFrameBytes) {
          finish(new LocalTransportError("CONTROL_RESPONSE_TOO_LARGE", "Local daemon response exceeds the frame budget"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let response: LocalControlResponse<T>;
        try { response = decode(buffer.slice(0, newline)) as LocalControlResponse<T>; }
        catch (error) { finish(error instanceof Error ? error : new LocalTransportError("CONTROL_RESPONSE_INVALID", "Invalid local daemon response")); return; }
        if (response.type === "error") finish(new LocalTransportError(response.error?.code ?? "CONTROL_REQUEST_FAILED", response.error?.message ?? "Local daemon request failed"));
        else finish(undefined, response.value);
      });
      socket.on("error", (error) => finish(new LocalTransportError(error.code ?? "CONTROL_UNAVAILABLE", error.message)));
      socket.on("close", () => {
        if (!settled) finish(new LocalTransportError("CONTROL_RESPONSE_UNKNOWN", "Local daemon disconnected before returning a response"));
      });
    });
  }

  ping(): Promise<unknown> { return this.request({ type: "ping" }); }
}

export type EndpointProbe = "live" | "stale" | "unavailable" | "missing";

export async function probeLocalEndpoint(endpoint: string, timeoutMs = 500): Promise<EndpointProbe> {
  if (!existsSync(endpoint)) return "missing";
  try { await new LocalControlClient({ endpoint, timeoutMs }).ping(); return "live"; }
  catch (error) {
    const code = errorCode(error);
    if (code === "ECONNREFUSED" || code === "ENOENT") return "stale";
    if (code === "CONTROL_RESPONSE_UNKNOWN") return "unavailable";
    return "unavailable";
  }
}

export function removeProvenStaleSocket(endpoint: string, probe: EndpointProbe): boolean {
  if (probe !== "stale" || !existsSync(endpoint)) return false;
  try {
    const stat = lstatSync(endpoint);
    if (stat.isSocket?.() !== true) return false;
    unlinkSync(endpoint);
    return true;
  } catch { return false; }
}
