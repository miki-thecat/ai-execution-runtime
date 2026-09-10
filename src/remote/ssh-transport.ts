import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceId } from "../core/ids.ts";
import type { LocalControlRequest } from "./contracts.ts";
import { LocalControlClient, LocalTransportError } from "./local-transport.ts";

export interface SshTransportOptions {
  readonly host: string;
  readonly remoteSocket: string;
  readonly expectedDeviceId: DeviceId;
  readonly startupTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  /** Trusted executable/process seam, primarily for deterministic tests. */
  readonly spawnProcess?: typeof spawn;
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code: string): LocalTransportError => new LocalTransportError(code, "SSH private transport is unavailable");

/** One tunnel lifetime; never reconnects or replays requests. Close in finally. */
export class SshControlClient extends LocalControlClient {
  private stopped = false;
  private closed = false;
  private cleanup: Promise<void> | undefined;
  private readonly process: ReturnType<typeof spawn>;

  private readonly options: SshTransportOptions;
  private readonly directory: string;

  private constructor(options: SshTransportOptions, directory: string) {
    super({ endpoint: join(directory, "control.sock"), timeoutMs: options.timeoutMs ?? 30_000 });
    this.options = options;
    this.directory = directory;
    const args = ["-N", "-T", "-a", "-x", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "StreamLocalBindMask=0177",
      "-o", "StreamLocalBindUnlink=no", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1",
      "-L", `${this.endpoint}:${options.remoteSocket}`, options.host];
    this.process = (options.spawnProcess ?? spawn)("ssh", args, { shell: false, stdio: ["ignore", "ignore", "ignore"] });
    this.process.on("error", () => { this.stopped = true; });
    this.process.on("close", () => { this.stopped = true; this.closed = true; });
  }

  static async connect(options: SshTransportOptions): Promise<SshControlClient> {
    // Restrict forwarding grammar and prevent option injection. SSH config aliases are supported.
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(options.host)
      || !/^\/[a-zA-Z0-9_./-]+$/.test(options.remoteSocket) || !options.expectedDeviceId) {
      throw new TypeError("SSH host, absolute remote socket, and expected deviceId are required");
    }
    for (const ms of [options.startupTimeoutMs ?? 5_000, options.timeoutMs ?? 30_000, options.cleanupTimeoutMs ?? 500]) {
      if (!Number.isSafeInteger(ms) || ms < 1) throw new RangeError("SSH timeouts must be positive integers");
    }
    const directory = mkdtempSync(join(tmpdir(), "aer-ssh-"));
    let client: SshControlClient | undefined;
    try {
      chmodSync(directory, 0o700);
      client = new SshControlClient(options, directory);
      const end = Date.now() + (options.startupTimeoutMs ?? 5_000);
      while (!client.stopped && !existsSync(client.endpoint) && Date.now() < end) await pause(Math.min(10, Math.max(1, end - Date.now())));
      if (client.stopped || !existsSync(client.endpoint) || lstatSync(client.endpoint).isSocket?.() !== true) throw failure("SSH_STARTUP_FAILED");
      return client;
    } catch (error) {
      if (client) await client.close();
      else rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  override async request<T = unknown>(request: LocalControlRequest): Promise<T> {
    let timeoutMs = this.timeoutMs;
    if (request.type === "execute") {
      const { envelope } = request;
      const ids = [envelope.deviceId, envelope.target?.deviceId].filter(id => id !== undefined);
      if (ids.length === 0 || ids.some(id => id !== this.options.expectedDeviceId)) throw failure("DEVICE_TRANSPORT_UNBOUND");
      const deadline = envelope.deadline ?? envelope.serverDeadline;
      if (deadline !== undefined && Number.isFinite(deadline)) {
        if (deadline <= Date.now()) throw failure("CONTROL_TIMEOUT");
        timeoutMs = Math.min(timeoutMs, Math.max(1, Math.floor(deadline - Date.now())));
      }
    }
    if (this.stopped) throw failure("CONTROL_UNAVAILABLE");
    // Delegate framing and ambiguous disconnect/timeout handling to the existing protocol.
    return new LocalControlClient({ endpoint: this.endpoint, timeoutMs }).request<T>(request);
  }

  close(): Promise<void> {
    this.cleanup ??= this.dispose();
    return this.cleanup;
  }

  private async dispose(): Promise<void> {
    this.stopped = true;
    try {
      if (!this.closed) this.process.kill("SIGTERM");
      const end = Date.now() + (this.options.cleanupTimeoutMs ?? 500);
      while (!this.closed && Date.now() < end) await pause(10);
      if (!this.closed) this.process.kill("SIGKILL");
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
