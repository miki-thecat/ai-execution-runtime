import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import type {
  AgentExecutor,
  CapabilitySet,
  CommandOutput,
  CommandSpec,
  Device,
  ExecutorRequest,
  RemoteTransport,
  RuntimeResult,
  Sandbox,
  SandboxProvider,
} from './types.ts';
import { error, failure, success } from './types.ts';
import { DirectExecutor } from './direct.ts';

const execFileAsync = promisify(execFile);

const unavailable = <T>(message: string): RuntimeResult<T> => failure(error('UNAVAILABLE', message, true));

/** Optional Codex integration. DirectExecutor remains usable without this adapter. */
export class CodexExecutorAdapter implements AgentExecutor {
  private readonly executable: string;

  constructor(executable = 'codex') {
    this.executable = executable;
  }

  async capabilities(): Promise<CapabilitySet> {
    const result = await execFileAsync(this.executable, ['--version'], { timeout: 2_000, maxBuffer: 4_096 }).catch(() => undefined);
    return {
      name: 'codex',
      version: result === undefined ? 'unavailable' : result.stdout.trim(),
      capabilities: result === undefined ? [] : ['agent.exec'],
    };
  }

  async run(request: ExecutorRequest): Promise<RuntimeResult<CommandOutput>> {
    const started = Date.now();
    try {
      const result = await execFileAsync(this.executable, ['exec', request.prompt], {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        maxBuffer: 64 * 1024,
      });
      return success({
        command: `${this.executable} exec <prompt>`,
        exitCode: 0,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: Date.now() - started,
        artifactRefs: [],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(error('COMMAND_FAILED', message, false));
    }
  }
}

/** A no-network transport contract for a future ChatGPT↔PC relay/tunnel. */
export class LocalTransport implements RemoteTransport {
  private readonly executor: DirectExecutor;
  private readonly deviceName: string;

  constructor(executor: DirectExecutor, deviceName = 'local') {
    this.executor = executor;
    this.deviceName = deviceName;
  }

  capabilities(): CapabilitySet {
    return { name: 'local-transport', version: '0.1', capabilities: ['device.list', 'command.execute'] };
  }

  async listDevices(): Promise<Device[]> {
    return [{ id: 'local', name: this.deviceName, platform: platform(), online: true, capabilities: ['shell.run', 'file.read', 'search'] }];
  }

  async execute(deviceId: string, request: CommandSpec): Promise<RuntimeResult<CommandOutput>> {
    if (deviceId !== 'local') return failure(error('NOT_FOUND', `Device not found: ${deviceId}`));
    return this.executor.execute(request);
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  private readonly executor: DirectExecutor;

  constructor(executor: DirectExecutor) {
    this.executor = executor;
  }

  capabilities(): CapabilitySet {
    return { name: 'local', version: '0.1', capabilities: ['process', 'filesystem'] };
  }

  async create(rootPath: string): Promise<RuntimeResult<Sandbox>> {
    return success({ id: randomUUID(), rootPath, provider: 'local', capabilities: ['direct-process', 'project-root-bound'] });
  }

  async execute(_sandbox: Sandbox, request: CommandSpec): Promise<RuntimeResult<CommandOutput>> {
    return this.executor.execute(request);
  }

  async dispose(_sandbox: Sandbox): Promise<RuntimeResult<void>> {
    return success(undefined);
  }
}

/** Capability placeholder for a future microVM implementation. */
export class MicroVmSandboxProvider implements SandboxProvider {
  capabilities(): CapabilitySet {
    return { name: 'microvm', version: '0.1', capabilities: [] };
  }

  async create(_rootPath: string): Promise<RuntimeResult<Sandbox>> {
    return unavailable('MicroVM sandbox provider is a capability contract only in Full Alpha');
  }

  async execute(_sandbox: Sandbox, _request: CommandSpec): Promise<RuntimeResult<CommandOutput>> {
    return unavailable('MicroVM sandbox provider is not implemented');
  }

  async dispose(_sandbox: Sandbox): Promise<RuntimeResult<void>> {
    return unavailable('MicroVM sandbox provider is not implemented');
  }
}

/** Capability placeholder for Docker Sandbox integration; no daemon calls are made. */
export class DockerSandboxProvider extends MicroVmSandboxProvider {
  override capabilities(): CapabilitySet {
    return { name: 'docker-sandbox', version: '0.1', capabilities: [] };
  }
}
