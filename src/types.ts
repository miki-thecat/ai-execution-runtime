import type { ChildProcess } from 'node:child_process';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RuntimeErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'COMMAND_FAILED'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, JsonValue>;
}

export interface ResultMeta {
  requestId?: string;
  durationMs?: number;
  eventIds?: string[];
  artifactRefs?: ArtifactRef[];
}

export type RuntimeResult<T> =
  | { ok: true; value: T; meta?: ResultMeta }
  | { ok: false; error: RuntimeError; meta?: ResultMeta };

export interface ArtifactRef {
  id: string;
  kind: 'stdout' | 'stderr' | 'file' | 'patch' | 'verification';
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export type EventKind =
  | 'run'
  | 'task'
  | 'tool'
  | 'process'
  | 'verification'
  | 'project'
  | 'agent'
  | 'sandbox';

export type EventStatus = 'started' | 'succeeded' | 'failed' | 'cancelled';

export interface RuntimeEvent {
  id: string;
  projectId: string;
  runId?: string;
  taskId?: string;
  kind: EventKind;
  name: string;
  status: EventStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attempt: number;
  retryCount: number;
  bytesIn: number;
  bytesOut: number;
  summary: string;
  metadata: Record<string, JsonValue>;
}

export interface Project {
  id: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  summary: string;
  createdAt: string;
}

export interface GitState {
  available: boolean;
  branch?: string;
  clean?: boolean;
  status?: string[];
  error?: string;
}

export interface ProjectState {
  project: Project;
  git: GitState;
  recentTasks: Task[];
  recentEvents: RuntimeEvent[];
  recentDecisions: Decision[];
  recentArtifacts: ArtifactRef[];
}

export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  artifactThresholdBytes?: number;
}

export interface CommandOutput {
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  artifactRefs: ArtifactRef[];
}

export interface ProcessHandle {
  processId: string;
  command: string;
  startedAt: string;
  child: ChildProcess;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface VerificationResult {
  passed: boolean;
  commands: Array<CommandOutput & { name?: string }>;
  durationMs: number;
}

export interface CapabilitySet {
  name: string;
  version: string;
  capabilities: string[];
}

export interface ExecutorRequest {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
}

export interface AgentExecutor {
  capabilities(): Promise<CapabilitySet>;
  run(request: ExecutorRequest): Promise<RuntimeResult<CommandOutput>>;
}

export interface Device {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  online: boolean;
  capabilities: string[];
}

export interface RemoteTransport {
  capabilities(): CapabilitySet;
  listDevices(): Promise<Device[]>;
  execute(deviceId: string, request: CommandSpec): Promise<RuntimeResult<CommandOutput>>;
}

export interface Sandbox {
  id: string;
  rootPath: string;
  provider: string;
  capabilities: string[];
}

export interface SandboxProvider {
  capabilities(): CapabilitySet;
  create(rootPath: string): Promise<RuntimeResult<Sandbox>>;
  execute(sandbox: Sandbox, request: CommandSpec): Promise<RuntimeResult<CommandOutput>>;
  dispose(sandbox: Sandbox): Promise<RuntimeResult<void>>;
}

export interface MetricsSnapshot {
  toolCalls: number;
  successfulCalls: number;
  failedCalls: number;
  durationMs: number;
  pollingCalls: number;
  retries: number;
  outputBytes: number;
}

export interface MetricsHooks {
  recordToolCall(input: { durationMs: number; success: boolean; outputBytes: number; polling?: boolean; retries?: number }): void;
  snapshot(): MetricsSnapshot;
}

export const success = <T>(value: T, meta?: ResultMeta): RuntimeResult<T> =>
  meta === undefined ? { ok: true, value } : { ok: true, value, meta };

export const failure = <T = never>(error: RuntimeError, meta?: ResultMeta): RuntimeResult<T> =>
  meta === undefined ? { ok: false, error } : { ok: false, error, meta };

export const error = (
  code: RuntimeErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, JsonValue>,
): RuntimeError => details === undefined ? { code, message, retryable } : { code, message, retryable, details };
