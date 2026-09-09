import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pid } from "node:process";
import {
  capabilityMap,
  createDeviceId,
  EFFECT_CLASSES,
  createOperationContext,
  createOperationMeta,
  createRuntimeError,
  createSpanId,
  createTraceId,
  createRunId,
  fullAlphaDefaultPolicy,
  isRuntimeError,
  runtimeFailure,
  type Actor,
  type DeviceId,
  type EffectClass,
  type EffectPolicy,
  type OperationContext,
  type RuntimeError,
  type RuntimeResult,
  type RuntimeStatus,
} from "../core/index.ts";
import { FileArtifactStore, type ArtifactStore } from "../artifacts/index.ts";
import { DirectExecutor, type DirectExecutionOptions, type DirectProcessManager } from "../direct/index.ts";
import { Tracer } from "../observability/index.ts";
import { Redactor } from "../observability/redaction.ts";
import { OperationRegistry } from "../operations/index.ts";
import type { Operation } from "../operations/operation.ts";
import { ProjectRegistry } from "../project/index.ts";
import type { ProjectIdentity, ProjectRegistrationInput } from "../project/types.ts";
import {
  createRequestId,
  type DeviceCapabilities,
  type DeviceIdentity,
  type DevicePresence,
  type LocalControlRequest,
  type SemanticOperationEnvelope,
} from "../remote/index.ts";
import {
  LocalControlClient,
  LocalControlServer,
  LocalTransportError,
  probeLocalEndpoint,
  removeProvenStaleSocket,
} from "../remote/local-transport.ts";
import type { StateEntity, StateStore } from "../state/index.ts";
import { SqliteStateStore } from "../state/index.ts";
import { DEFAULT_RUNTIME_BUDGETS, resolveRuntimeBudgets, type RuntimeBudgets, type RuntimeBudgetOverrides } from "../policy/budgets.ts";
import type { RuntimeEventInput } from "../observability/events.ts";

export const DEFAULT_AER_DATA_ROOT = join(homedir(), ".aer");
export const DEFAULT_AER_RUNTIME_DIRECTORY = "runtime";
export const DEFAULT_AER_SOCKET_NAME = "aer.sock";
export const DEFAULT_DAEMON_MAX_REQUEST_BYTES = 256 * 1024;

export interface EffectReceipt {
  readonly receiptId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly operation: string;
  readonly effectClass: EffectClass;
  readonly effectState: "none" | "unknown" | "applied";
  readonly status: Extract<RuntimeStatus, "completed" | "failed" | "unknown">;
  readonly projectId?: string;
  readonly deviceId?: DeviceId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly replayed?: boolean;
}

export type DaemonOperationResult<T> = RuntimeResult<T> & { readonly receipt?: EffectReceipt };

interface StoredReceiptData {
  readonly version: 1;
  readonly idempotencyKeyHash: string;
  readonly fingerprint: string;
  readonly argumentsDigest: string;
  readonly operation: string;
  readonly effectClass: EffectClass;
  readonly effectState: "none" | "unknown" | "applied";
  readonly status: Extract<RuntimeStatus, "running" | "completed" | "failed" | "unknown">;
  readonly projectId?: string;
  readonly deviceId?: DeviceId;
  readonly authorityScopeDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: unknown;
}

export interface AERDaemonOptions {
  readonly dataRoot?: string;
  readonly endpoint?: string;
  readonly state?: StateStore;
  readonly tracer?: Tracer;
  readonly artifacts?: ArtifactStore;
  readonly projects?: ProjectRegistry;
  readonly operations?: OperationRegistry;
  readonly operationRegistry?: OperationRegistry;
  readonly policy?: EffectPolicy;
  readonly budgets?: RuntimeBudgetOverrides;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly controlTimeoutMs?: number;
  readonly deviceId?: DeviceId;
  readonly deviceName?: string;
  readonly deviceCapabilities?: DeviceCapabilities;
  readonly direct?: DirectExecutor;
  readonly directOptions?: Omit<DirectExecutionOptions, "state" | "artifacts" | "tracer">;
}

export interface DeviceRegistration {
  readonly deviceId?: DeviceId;
  readonly name?: string;
  readonly capabilities?: DeviceCapabilities;
  readonly presence?: DevicePresence;
}

function now(): string { return new Date().toISOString(); }

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown, seen = new Set<unknown>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Semantic input must contain finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "object") throw new TypeError("Semantic input must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("Semantic input must not be cyclic");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) result = `[${value.map((item) => stable(item, seen)).join(",")}]`;
  else {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    result = `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stable(child, seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function authorityFor(envelope: SemanticOperationEnvelope): { readonly principal: string; readonly scope: readonly string[] } {
  const caller = envelope.caller;
  const principal = envelope.principal ?? caller?.principal ?? envelope.actor ?? "unknown";
  const scope = [...new Set(envelope.authorityScope ?? caller?.authorityScope ?? [])].sort();
  return { principal, scope };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(stable(value)).byteLength;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function daemonError(code: string, message: string, details?: Readonly<Record<string, unknown>>): RuntimeError {
  return createRuntimeError({ code, message, retryable: code === "DAEMON_ENDPOINT_UNCERTAIN", effect: "none", ...(details === undefined ? {} : { details }) });
}

function projectInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function safeStoredValue(value: unknown): unknown {
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as unknown;
    return new Redactor().sanitizeMetadata({ result: parsed }).result;
  } catch { return { redacted: true, reason: "non_serializable_result" }; }
}

function operationStatus(result: RuntimeResult<unknown>): Extract<RuntimeStatus, "completed" | "failed" | "unknown"> {
  return result.ok ? "completed" : result.meta.status === "unknown" || result.error.effect === "unknown" ? "unknown" : "failed";
}

/**
 * The Full Alpha local runtime owner. Clients use its control socket for
 * semantic work; they do not open a competing canonical SQLite writer.
 */
export class AERDaemon {
  readonly dataRoot: string;
  readonly endpoint: string;
  readonly state: StateStore;
  readonly tracer: Tracer;
  readonly artifacts: ArtifactStore;
  readonly projects: ProjectRegistry;
  readonly operations: OperationRegistry;
  readonly direct: DirectExecutor;
  readonly processes: DirectProcessManager;
  readonly budgets: RuntimeBudgets;
  readonly policy: EffectPolicy;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly controlTimeoutMs: number;

  private readonly ownsState: boolean;
  private readonly devices = new Map<DeviceId, DeviceIdentity>();
  private readonly localDeviceId: DeviceId;
  private readonly localDeviceName: string;
  private readonly localDeviceCapabilities: DeviceCapabilities;
  private readonly control: LocalControlServer;
  private readonly tracerPersistsState: boolean;
  private queue: Promise<void> = Promise.resolve();
  private running = false;

  constructor(options: AERDaemonOptions = {}) {
    this.dataRoot = options.dataRoot ?? DEFAULT_AER_DATA_ROOT;
    this.ownsState = options.state === undefined;
    this.state = options.state ?? new SqliteStateStore({ dataRoot: this.dataRoot });
    this.endpoint = options.endpoint ?? join(this.dataRoot, DEFAULT_AER_RUNTIME_DIRECTORY, DEFAULT_AER_SOCKET_NAME);
    this.policy = options.policy ?? fullAlphaDefaultPolicy();
    this.budgets = resolveRuntimeBudgets(options.budgets);
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_DAEMON_MAX_REQUEST_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? this.maxRequestBytes;
    this.controlTimeoutMs = options.controlTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) throw new RangeError("maxRequestBytes must be a positive integer");
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new RangeError("maxResponseBytes must be a positive integer");
    if (!Number.isSafeInteger(this.controlTimeoutMs) || this.controlTimeoutMs < 1) throw new RangeError("controlTimeoutMs must be a positive integer");

    if (options.tracer === undefined || options.tracer.sink === this.state) {
      this.tracerPersistsState = true;
      this.tracer = options.tracer ?? new Tracer({ sink: this.state });
    }
    else {
      this.tracerPersistsState = true;
      const supplied = options.tracer;
      this.tracer = new Tracer({
        redactor: supplied.redactor,
        clock: () => supplied.now(),
        sink: { append: (event) => { this.state.append(event); supplied.sink.append(event); } },
      });
    }
    this.artifacts = options.artifacts ?? new FileArtifactStore({ dataRoot: this.dataRoot, state: this.state });
    this.projects = options.projects ?? new ProjectRegistry({ state: this.state });
    this.operations = options.operations ?? options.operationRegistry ?? new OperationRegistry({ tracer: this.tracer, policy: this.policy });
    this.direct = options.direct ?? new DirectExecutor({
      tracer: this.tracer,
      state: this.state,
      artifacts: this.artifacts,
      ...(options.directOptions ?? {}),
    });
    this.processes = this.direct.processes;

    const persistedLocal = this.state.listEntities("devices").find((entity) => entity.data?.local === true);
    this.localDeviceId = options.deviceId ?? (persistedLocal?.id as DeviceId | undefined) ?? createDeviceId();
    this.localDeviceName = options.deviceName ?? (typeof persistedLocal?.data?.name === "string" ? persistedLocal.data.name : "local-device");
    this.localDeviceCapabilities = options.deviceCapabilities ?? (persistedLocal?.data?.capabilities as DeviceCapabilities | undefined) ?? { features: { local: true } };
    this.loadDevices();
    this.control = new LocalControlServer({
      endpoint: this.endpoint,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      handle: (request) => this.handleControlRequest(request),
    });
  }

  get isRunning(): boolean { return this.running; }
  get deviceId(): DeviceId { return this.localDeviceId; }
  get localDevice(): DeviceIdentity | undefined { return this.devices.get(this.localDeviceId); }

  register<Input, Output>(operation: Operation<Input, Output>): this {
    this.operations.register(operation);
    return this;
  }

  registerOperation<Input, Output>(operation: Operation<Input, Output>): this { return this.register(operation); }

  registerProject(input: ProjectRegistrationInput | string): ProjectIdentity {
    return this.projects.register(input);
  }

  registerDevice(input: DeviceRegistration = {}): DeviceIdentity {
    const deviceId = input.deviceId ?? createDeviceId();
    const previous = this.devices.get(deviceId);
    const timestamp = now();
    const identity: DeviceIdentity = {
      deviceId,
      name: input.name ?? previous?.name ?? (deviceId === this.localDeviceId ? this.localDeviceName : "device"),
      capabilities: input.capabilities ?? previous?.capabilities ?? {},
      presence: input.presence ?? (this.running ? "online" : "offline"),
      ...(input.presence === "online" || (input.presence === undefined && this.running) ? { connectedAt: previous?.connectedAt ?? timestamp } : previous?.connectedAt === undefined ? {} : { connectedAt: previous.connectedAt }),
      lastSeenAt: timestamp,
    };
    this.devices.set(deviceId, identity);
    this.state.saveEntity({
      kind: "devices",
      id: deviceId,
      status: identity.presence,
      createdAt: previous?.lastSeenAt ?? timestamp,
      updatedAt: timestamp,
      data: { local: deviceId === this.localDeviceId, ...identity },
    });
    if (identity.presence === "online" && previous?.presence !== "online") this.emitDeviceEvent("device.connected", identity);
    return identity;
  }

  getDevice(deviceId: DeviceId): DeviceIdentity | undefined { return this.devices.get(deviceId); }
  listDevices(): readonly DeviceIdentity[] { return [...this.devices.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId)); }

  async start(): Promise<this> {
    if (this.running) return this;
    const parent = this.endpoint.slice(0, Math.max(this.endpoint.lastIndexOf("/"), 0));
    if (parent !== "") { mkdirSync(parent, { recursive: true, mode: 0o700 }); chmodSync(parent, 0o700); }
    await this.reconcileEndpoint();
    try { await this.control.start(); }
    catch (error) {
      if (errorCode(error) !== "EADDRINUSE") throw error;
      await this.reconcileEndpoint();
      try { await this.control.start(); }
      catch { throw daemonError("DAEMON_ALREADY_RUNNING", "Another live AER daemon owns the local control endpoint"); }
    }
    chmodSync(this.endpoint, 0o600);
    this.running = true;
    this.registerDevice({ deviceId: this.localDeviceId, name: this.localDeviceName, capabilities: this.localDeviceCapabilities, presence: "online" });
    return this;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const local = this.devices.get(this.localDeviceId);
    if (local !== undefined) this.setPresence(localDeviceOffline(local));
    await this.control.close();
    try {
      if (existsSync(this.endpoint) && lstatSync(this.endpoint).isSocket?.() === true) unlinkSync(this.endpoint);
    } catch { /* A replaced endpoint is not ours to remove. */ }
    if (this.ownsState) this.state.close();
  }

  close(): Promise<void> { return this.stop(); }

  client(): LocalDaemonClient {
    return new LocalDaemonClient({ endpoint: this.endpoint, timeoutMs: this.controlTimeoutMs, maxFrameBytes: this.maxResponseBytes });
  }

  async execute<Input, Output>(envelope: SemanticOperationEnvelope<Input>): Promise<DaemonOperationResult<Output>> {
    const work = this.queue.then(() => this.executeOne<Input, Output>(envelope)).catch((cause: unknown) => this.validationFailure<Input, Output>(envelope, cause));
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }

  invoke<Input, Output>(envelope: SemanticOperationEnvelope<Input>): Promise<DaemonOperationResult<Output>> { return this.execute(envelope); }
  route<Input, Output>(envelope: SemanticOperationEnvelope<Input>): Promise<DaemonOperationResult<Output>> { return this.execute(envelope); }

  private async handleControlRequest(request: LocalControlRequest): Promise<unknown> {
    if (request.type === "ping") return { daemon: "aer", pid, endpoint: this.endpoint };
    return this.execute(request.envelope);
  }

  private validationFailure<Input, Output>(envelope: SemanticOperationEnvelope<Input>, cause: unknown): DaemonOperationResult<Output> {
    const error = isRuntimeError(cause)
      ? cause
      : createRuntimeError({ code: errorCode(cause) ?? "DAEMON_REQUEST_INVALID", message: cause instanceof Error ? cause.message : "Daemon request is invalid", retryable: false, effect: "none" });
    const context = createOperationContext({
      traceId: envelope.traceId ?? createTraceId(),
      runId: envelope.runId ?? createRunId(),
      actor: envelope.actor ?? "model",
      ...(envelope.idempotencyKey === undefined ? {} : { idempotencyKey: envelope.idempotencyKey }),
    });
    const effectClass = envelope.effectClass ?? envelope.assertedEffectClass ?? "read";
    return runtimeFailure(error, createOperationMeta({ context, operation: envelope.operation ?? "unknown", status: error.effect === "unknown" ? "unknown" : "failed", effectClass, effectState: error.effect, summary: error.message }));
  }

  private async reconcileEndpoint(): Promise<void> {
    if (!existsSync(this.endpoint)) return;
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(this.endpoint); }
    catch { throw daemonError("DAEMON_ENDPOINT_UNAVAILABLE", "The local daemon endpoint cannot be inspected"); }
    if (stat.isSocket?.() !== true) throw daemonError("DAEMON_ENDPOINT_NOT_SOCKET", "The configured daemon endpoint is not a Unix socket");
    const probe = await probeLocalEndpoint(this.endpoint, 500);
    if (probe === "live") throw daemonError("DAEMON_ALREADY_RUNNING", "Another live AER daemon owns the local control endpoint");
    if (probe !== "stale" || !removeProvenStaleSocket(this.endpoint, probe)) {
      throw daemonError("DAEMON_ENDPOINT_UNCERTAIN", "The daemon endpoint exists but AER could not prove that its owner is dead");
    }
  }

  private async executeOne<Input, Output>(raw: SemanticOperationEnvelope<Input>): Promise<DaemonOperationResult<Output>> {
    const envelope = this.normalizeEnvelope(raw);
    const registered = this.operations.get<unknown, unknown>(envelope.operation);
    const idempotencyKey = envelope.idempotencyKey ?? envelope.idempotency?.key;
    const receiptId = idempotencyKey === undefined ? undefined : this.receiptId(idempotencyKey);
    const priorReceipt = receiptId === undefined ? undefined : this.state.getEntity("effect_receipts", receiptId);
    const priorEffect = priorReceipt?.data?.effectClass;
    const effectClass = registered?.effectClass ?? (typeof priorEffect === "string" && EFFECT_CLASSES.includes(priorEffect as EffectClass) ? priorEffect as EffectClass : "read");
    const device = this.resolveDevice(envelope.deviceId ?? envelope.target?.deviceId);
    if (device.capabilities.operations !== undefined && !device.capabilities.operations.includes(envelope.operation)) {
      throw daemonError("DEVICE_CAPABILITY_MISSING", "Target device does not advertise the requested semantic operation", { operation: envelope.operation, deviceId: device.deviceId });
    }
    const project = this.resolveProject(envelope.projectId ?? envelope.target?.projectId);
    const input = this.confineInput(envelope.input === undefined ? envelope.validatedInput : envelope.input, project?.rootDir);
    const context = this.contextFor(envelope, effectClass, device, project, input);
    const requestMetadata = {
      requestId: envelope.requestId,
      ...(envelope.principal === undefined ? {} : { principal: envelope.principal }),
      ...(envelope.idempotencyKey === undefined ? {} : { receipt: "requested" }),
    };
    this.emit({
      traceId: context.traceId,
      runId: context.runId,
      spanId: context.spanId ?? createSpanId(),
      type: "remote.requested",
      actor: context.actor,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      operation: envelope.operation,
      status: "running",
      effectClass,
      effectState: "none",
      ...(envelope.idempotencyKey === undefined ? {} : { idempotencyKey: envelope.idempotencyKey }),
      metadata: requestMetadata,
    });

    const fingerprint = idempotencyKey === undefined ? undefined : this.fingerprint(envelope, input, effectClass, device.deviceId, project?.projectId);
    if (receiptId !== undefined && fingerprint !== undefined) {
      const receiptKey = idempotencyKey;
      if (receiptKey === undefined) throw daemonError("IDEMPOTENCY_KEY_INVALID", "An idempotency receipt requires a key");
      const existing = priorReceipt ?? this.state.getEntity("effect_receipts", receiptId);
      if (existing !== undefined) {
        const stored = existing.data as StoredReceiptData | undefined;
        if (stored?.fingerprint !== fingerprint) {
          return this.finish(envelope, context, effectClass, runtimeFailure(
            createRuntimeError({ code: "IDEMPOTENCY_CONFLICT", message: "The idempotency key is already bound to a different semantic intent", retryable: false, effect: "none", details: { receiptId, fingerprint, existingFingerprint: stored?.fingerprint } }),
            createOperationMeta({ context, operation: envelope.operation, status: "failed", effectClass, effectState: "none", summary: "Idempotency fingerprint conflict" }),
          ));
        }
        const replay = this.replayReceipt(existing, context, envelope.operation, effectClass);
        if (stored !== undefined && replay !== undefined && idempotencyKey !== undefined) return this.finish(envelope, context, effectClass, replay as DaemonOperationResult<Output>, this.publicReceipt(stored, receiptId, idempotencyKey, true));
      }
      const timestamp = now();
      this.state.saveEntity({
        kind: "effect_receipts",
        id: receiptId,
        ...(project === undefined ? {} : { projectId: project.projectId }),
        status: "running",
        createdAt: timestamp,
        updatedAt: timestamp,
        data: {
          version: 1,
          idempotencyKeyHash: digest(receiptKey),
          fingerprint,
          argumentsDigest: digest(stable(input)),
          operation: envelope.operation,
          effectClass,
          effectState: "unknown",
          status: "running",
          ...(project === undefined ? {} : { projectId: project.projectId }),
          deviceId: device.deviceId,
          authorityScopeDigest: digest(stable(authorityFor(envelope))),
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies StoredReceiptData,
      });
    }

    let result: DaemonOperationResult<Output>;
    try {
      result = await this.operations.execute<unknown, Output>(envelope.operation, input, context);
    } catch (cause) {
      const error = isRuntimeError(cause) ? cause : createRuntimeError({ code: errorCode(cause) ?? "DAEMON_DISPATCH_FAILED", message: cause instanceof Error ? cause.message : "Daemon dispatch failed", retryable: false, effect: "unknown" });
      result = runtimeFailure(error, createOperationMeta({ context, operation: envelope.operation, status: error.effect === "unknown" ? "unknown" : "failed", effectClass, effectState: error.effect }));
    }
    result = this.enforceOutputBudget(result, context, effectClass);

    if (receiptId !== undefined && fingerprint !== undefined && idempotencyKey !== undefined) {
      const timestamp = now();
      const status = operationStatus(result);
      const stored: StoredReceiptData = {
        version: 1,
        idempotencyKeyHash: digest(idempotencyKey),
        fingerprint,
        argumentsDigest: digest(stable(input)),
        operation: envelope.operation,
        effectClass,
        effectState: result.meta.effectState,
        status,
        ...(project === undefined ? {} : { projectId: project.projectId }),
        deviceId: device.deviceId,
        authorityScopeDigest: digest(stable(authorityFor(envelope))),
        createdAt: this.state.getEntity("effect_receipts", receiptId)?.createdAt ?? timestamp,
        updatedAt: timestamp,
        result: safeStoredValue(result),
      };
      this.state.saveEntity({ kind: "effect_receipts", id: receiptId, ...(project === undefined ? {} : { projectId: project.projectId }), status, createdAt: stored.createdAt, updatedAt: timestamp, data: stored as unknown as Readonly<Record<string, unknown>> });
      result = this.attachReceipt(result, this.publicReceipt(stored, receiptId, idempotencyKey, false));
    }
    return this.finish(envelope, context, effectClass, result);
  }

  private finish<T>(envelope: SemanticOperationEnvelope, context: OperationContext, effectClass: EffectClass, result: DaemonOperationResult<T>, receipt?: EffectReceipt): DaemonOperationResult<T> {
    const finalResult = receipt === undefined ? result : this.attachReceipt(result, receipt);
    const completedIdempotencyKey = envelope.idempotencyKey ?? envelope.idempotency?.key;
    this.emit({
      traceId: context.traceId,
      runId: context.runId,
      spanId: finalResult.meta.spanId,
      type: "remote.completed",
      actor: context.actor,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      operation: envelope.operation,
      status: finalResult.meta.status,
      effectClass,
      effectState: finalResult.meta.effectState,
      ...(completedIdempotencyKey === undefined ? {} : { idempotencyKey: completedIdempotencyKey }),
      ...(finalResult.ok ? {} : { errorCode: finalResult.error.code }),
      metadata: { requestId: envelope.requestId, ...(receipt === undefined ? {} : { receiptId: receipt.receiptId, replayed: receipt.replayed === true }) },
    });
    return finalResult;
  }

  private replayReceipt(entity: StateEntity, context: OperationContext, operation: string, effectClass: EffectClass): DaemonOperationResult<unknown> | undefined {
    const stored = entity.data as StoredReceiptData | undefined;
    if (stored?.result === undefined || stored.status === "running") {
      const error = createRuntimeError({ code: "EFFECT_STATE_UNKNOWN", message: "A prior daemon request did not leave a durable response; effect state is unknown", retryable: true, effect: "unknown" });
      return runtimeFailure(error, createOperationMeta({ context, operation, status: "unknown", effectClass, effectState: "unknown", summary: "Durable receipt has no terminal response" }));
    }
    const result = stored.result as DaemonOperationResult<unknown>;
    if (result.ok === true || result.ok === false) return result;
    return runtimeFailure(createRuntimeError({ code: "RECEIPT_INVALID", message: "Persisted effect receipt is invalid", retryable: false, effect: "unknown" }), createOperationMeta({ context, operation, status: "unknown", effectClass, effectState: "unknown" }));
  }

  private publicReceipt(stored: StoredReceiptData, receiptId: string, key: string, replayed: boolean): EffectReceipt {
    return {
      receiptId,
      idempotencyKey: key,
      fingerprint: stored.fingerprint,
      operation: stored.operation,
      effectClass: stored.effectClass,
      effectState: stored.effectState,
      status: stored.status === "running" ? "unknown" : stored.status,
      ...(stored.projectId === undefined ? {} : { projectId: stored.projectId }),
      ...(stored.deviceId === undefined ? {} : { deviceId: stored.deviceId }),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      ...(replayed ? { replayed: true } : {}),
    };
  }

  private attachReceipt<T>(result: RuntimeResult<T>, receipt: EffectReceipt): DaemonOperationResult<T> {
    return { ...result, receipt };
  }

  private normalizeEnvelope<Input>(raw: SemanticOperationEnvelope<Input>): SemanticOperationEnvelope<Input> {
    if (raw.protocol !== undefined && raw.protocol !== "aer.semantic-operation.v1") throw daemonError("REQUEST_PROTOCOL_UNSUPPORTED", "Semantic operation protocol is unsupported") as never;
    const requestId = raw.requestId ?? createRequestId();
    const traceId = raw.traceId ?? createTraceId();
    const runId = raw.runId ?? createRunId();
    if (typeof raw.operation !== "string" || raw.operation.trim() === "") throw daemonError("REQUEST_OPERATION_INVALID", "Semantic operation name is required") as never;
    if (raw.requestId !== undefined && (typeof raw.requestId !== "string" || raw.requestId.trim() === "")) throw daemonError("REQUEST_ID_INVALID", "Request ID must be non-empty") as never;
    const targetDevice = raw.target?.deviceId ?? raw.deviceId;
    const targetProject = raw.target?.projectId ?? raw.projectId;
    if (raw.target?.deviceId !== undefined && raw.deviceId !== undefined && raw.target.deviceId !== raw.deviceId) throw daemonError("REQUEST_TARGET_CONFLICT", "Device target aliases disagree") as never;
    if (raw.target?.projectId !== undefined && raw.projectId !== undefined && raw.target.projectId !== raw.projectId) throw daemonError("REQUEST_TARGET_CONFLICT", "Project target aliases disagree") as never;
    const input = raw.input === undefined ? raw.validatedInput : raw.input;
    if (raw.input !== undefined && raw.validatedInput !== undefined && stable(raw.input) !== stable(raw.validatedInput)) throw daemonError("REQUEST_INPUT_CONFLICT", "Input aliases disagree") as never;
    if (bytes(input) > this.maxRequestBytes) throw daemonError("REQUEST_TOO_LARGE", "Semantic operation input exceeds the daemon request budget") as never;
    const key = raw.idempotencyKey ?? raw.idempotency?.key;
    if (raw.idempotencyKey !== undefined && raw.idempotency?.key !== undefined && raw.idempotencyKey !== raw.idempotency.key) throw daemonError("REQUEST_IDEMPOTENCY_CONFLICT", "Idempotency key aliases disagree") as never;
    if (key !== undefined && (key.trim() === "" || key.length > 512)) throw daemonError("IDEMPOTENCY_KEY_INVALID", "Idempotency key must be non-empty and bounded") as never;
    const deadline = raw.deadline ?? raw.serverDeadline;
    if (deadline !== undefined && (Number.isNaN(deadline) || deadline !== Number.POSITIVE_INFINITY && !Number.isFinite(deadline))) throw daemonError("REQUEST_DEADLINE_INVALID", "Request deadline must be finite") as never;
    return {
      ...raw,
      protocol: "aer.semantic-operation.v1",
      requestId,
      traceId,
      runId,
      ...(targetDevice === undefined ? {} : { deviceId: targetDevice }),
      ...(targetProject === undefined ? {} : { projectId: targetProject }),
      ...(input === undefined ? {} : { input }),
      ...(key === undefined ? {} : { idempotencyKey: key }),
    };
  }

  private resolveDevice(deviceId: DeviceId | undefined): DeviceIdentity {
    const selected = this.devices.get(deviceId ?? this.localDeviceId);
    if (selected === undefined) throw daemonError("DEVICE_NOT_FOUND", "Target device is not registered");
    if (selected.presence !== "online") throw daemonError("DEVICE_OFFLINE", "Target device is offline");
    return selected;
  }

  private resolveProject(projectId: import("../core/ids.ts").ProjectId | undefined): ProjectIdentity | undefined {
    if (projectId === undefined) return undefined;
    const project = this.projects.get(projectId);
    if (project === undefined) throw daemonError("PROJECT_NOT_FOUND", "Target project is not registered", { projectId });
    if (project.boundary.root.status !== "trusted") throw daemonError("PROJECT_ROOT_UNTRUSTED", "Target project root is not trusted");
    return project;
  }

  private confineInput(input: unknown, rootDir: string | undefined): unknown {
    if (rootDir === undefined) {
      const record = asRecord(input);
      const rootBearing = record !== undefined && Object.keys(record).some((key) => ["rootDir", "workspaceRoot", "cwd", "workspace"].includes(key));
      if (rootBearing) throw daemonError("PROJECT_REQUIRED", "Root-bearing semantic input requires a canonical project target");
      return input;
    }
    const visit = (value: unknown, key?: string): unknown => {
      if (typeof value === "string" && key !== undefined && ["rootDir", "workspaceRoot", "cwd", "workspace"].includes(key)) {
        const candidate = isAbsolute(value) ? value : resolve(rootDir, value);
        if (!projectInside(rootDir, candidate)) throw daemonError("PROJECT_ROOT_ESCAPE", "Semantic input attempts to escape the canonical project root");
        try {
          const physical = realpathSync(candidate);
          if (!projectInside(rootDir, physical)) throw daemonError("PROJECT_ROOT_ESCAPE", "Semantic input resolves outside the canonical project root");
          return physical;
        } catch (error) {
          if (isRuntimeError(error)) throw error;
          throw daemonError("PROJECT_PATH_INVALID", "Semantic root-bearing input does not resolve inside the canonical project root");
        }
      }
      if (Array.isArray(value)) return value.map((child) => visit(child));
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, visit(child, childKey)]));
      return value;
    };
    return visit(input);
  }

  private effectiveBudgets(overrides: RuntimeBudgetOverrides | undefined): RuntimeBudgetOverrides {
    const values: Record<keyof RuntimeBudgets, number> = {} as Record<keyof RuntimeBudgets, number>;
    for (const key of Object.keys(DEFAULT_RUNTIME_BUDGETS) as (keyof RuntimeBudgets)[]) {
      const requested = overrides?.[key];
      values[key] = requested === undefined ? this.budgets[key] : Math.min(requested, this.budgets[key]);
    }
    return values;
  }

  private contextFor(envelope: SemanticOperationEnvelope, effectClass: EffectClass, device: DeviceIdentity, project: ProjectIdentity | undefined, input: unknown): OperationContext {
    const budgets = this.effectiveBudgets(envelope.budgets);
    const serverDeadline = Date.now() + this.budgets.maxExecutionMs;
    const requestedDeadline = envelope.deadline ?? envelope.serverDeadline;
    const deadline = requestedDeadline === undefined || requestedDeadline === Number.POSITIVE_INFINITY
      ? serverDeadline
      : Math.min(requestedDeadline, serverDeadline);
    const policy: EffectPolicy = project === undefined
      ? this.policy
      : { ...this.policy, workspaceRoot: project.rootDir };
    const capabilities = { ...capabilityMap(["remote"]), ...(device.capabilities.features ?? {}) };
    return createOperationContext({
      traceId: envelope.traceId,
      runId: envelope.runId,
      ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
      ...(project === undefined ? {} : { projectId: project.projectId }),
      deviceId: device.deviceId,
      actor: envelope.actor ?? "model",
      ...(envelope.spanId === undefined ? {} : { parentSpanId: envelope.spanId }),
      deadline,
      effectPolicy: policy,
      budgets,
      ...(envelope.idempotencyKey === undefined ? {} : { idempotencyKey: envelope.idempotencyKey }),
      capabilities,
    });
  }

  private fingerprint(envelope: SemanticOperationEnvelope, input: unknown, effectClass: EffectClass, deviceId: DeviceId, projectId: string | undefined): string {
    const authority = authorityFor(envelope);
    const argumentsDigest = digest(stable(input));
    return digest(stable({
      version: 1,
      operation: envelope.operation,
      argumentsDigest,
      projectId: projectId ?? null,
      deviceId,
      principal: authority.principal,
      authorityScope: authority.scope,
      effectClass,
    }));
  }

  private receiptId(key: string): string { return `receipt_${digest(key)}`; }

  private enforceOutputBudget<T>(result: DaemonOperationResult<T>, context: OperationContext, effectClass: EffectClass): DaemonOperationResult<T> {
    let outputBytes: number;
    try { outputBytes = bytes(result.ok ? result.data : result.error); }
    catch {
      outputBytes = context.budgets.maxReturnedOutputBytes + 1;
    }
    const outputBudget = Math.min(context.budgets.maxOutputBytes, context.budgets.maxReturnedOutputBytes);
    if (outputBytes <= outputBudget) return result;
    const effect = result.ok && effectClass !== "read" ? "unknown" : "none";
    const error = createRuntimeError({ code: "DAEMON_OUTPUT_TOO_LARGE", message: "Semantic operation output exceeds the server-owned response budget", retryable: false, effect, details: { outputBytes, maxOutputBytes: outputBudget } });
    return runtimeFailure(error, createOperationMeta({ context, operation: result.meta.operation, status: effect === "unknown" ? "unknown" : "failed", effectClass, effectState: effect, summary: error.message }));
  }

  private loadDevices(): void {
    for (const entity of this.state.listEntities("devices")) {
      const data = entity.data;
      if (data === undefined || typeof data.deviceId !== "string" || typeof data.name !== "string" || (data.presence !== "online" && data.presence !== "offline") || typeof data.lastSeenAt !== "string") continue;
      this.devices.set(entity.id as DeviceId, {
        deviceId: data.deviceId as DeviceId,
        name: data.name,
        capabilities: (data.capabilities as DeviceCapabilities | undefined) ?? {},
        presence: "offline",
        ...(typeof data.connectedAt === "string" ? { connectedAt: data.connectedAt } : {}),
        lastSeenAt: data.lastSeenAt,
      });
    }
  }

  private setPresence(device: DeviceIdentity): void {
    const next: DeviceIdentity = { ...device, presence: "offline", lastSeenAt: now() };
    this.devices.set(device.deviceId, next);
    this.state.saveEntity({ kind: "devices", id: device.deviceId, status: "offline", updatedAt: next.lastSeenAt, data: { local: device.deviceId === this.localDeviceId, ...next } });
    this.emitDeviceEvent("device.disconnected", next);
  }

  private emitDeviceEvent(type: "device.connected" | "device.disconnected", device: DeviceIdentity): void {
    const traceId = createTraceId();
    const runId = createRunId();
    this.emit({ traceId, runId, spanId: createSpanId(), type, actor: "system", deviceId: device.deviceId, status: device.presence === "online" ? "running" : "completed", metadata: { deviceId: device.deviceId, presence: device.presence, capabilities: device.capabilities } });
  }

  private emit(input: RuntimeEventInput): void {
    const event = this.tracer.emit(input);
    if (!this.tracerPersistsState) this.state.append(event);
  }
}

export class LocalDaemonClient {
  private readonly transport: LocalControlClient;

  constructor(options: { readonly endpoint: string; readonly timeoutMs?: number; readonly maxFrameBytes?: number } | string) {
    this.transport = new LocalControlClient(options);
  }

  ping(): Promise<unknown> { return this.transport.ping(); }

  async execute<Input, Output>(envelope: SemanticOperationEnvelope<Input>): Promise<DaemonOperationResult<Output>> {
    try {
      const result = await this.transport.request<DaemonOperationResult<Output>>({ type: "execute", envelope });
      return result;
    } catch (error) {
      const transportError = error instanceof LocalTransportError ? error : new LocalTransportError("CONTROL_UNAVAILABLE", error instanceof Error ? error.message : "Local daemon is unavailable");
      const unknown = transportError.code === "CONTROL_RESPONSE_UNKNOWN" || transportError.code === "CONTROL_TIMEOUT";
      const effect = envelope.effectClass === "read" || envelope.assertedEffectClass === "read" ? "none" : "unknown";
      const context = createOperationContext({ traceId: envelope.traceId, runId: envelope.runId, actor: envelope.actor ?? "model", effectPolicy: fullAlphaDefaultPolicy(), ...(envelope.idempotencyKey === undefined ? {} : { idempotencyKey: envelope.idempotencyKey }) });
      const runtimeError = createRuntimeError({ code: unknown ? "DAEMON_RESPONSE_UNKNOWN" : transportError.code, message: transportError.message, retryable: true, effect });
      return runtimeFailure(runtimeError, createOperationMeta({ context, operation: envelope.operation, status: "unknown", effectClass: envelope.effectClass ?? envelope.assertedEffectClass ?? "read", effectState: effect === "unknown" ? "unknown" : "none", summary: "Local daemon response was not received" }));
    }
  }

  invoke<Input, Output>(envelope: SemanticOperationEnvelope<Input>): Promise<DaemonOperationResult<Output>> { return this.execute(envelope); }
}

export const AerDaemon = AERDaemon;
export const Daemon = AERDaemon;
export const DaemonServer = AERDaemon;
export const createDaemon = (options: AERDaemonOptions = {}): AERDaemon => new AERDaemon(options);
export const createAERDaemon = createDaemon;
export const startDaemon = async (options: AERDaemonOptions = {}): Promise<AERDaemon> => createDaemon(options).start();

function localDeviceOffline(device: DeviceIdentity): DeviceIdentity {
  return { ...device, presence: "offline" };
}
