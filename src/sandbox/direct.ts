import type { OperationContext } from "../core/context.ts";
import type { EffectClass } from "../core/effects.ts";
import { DirectExecutor } from "../direct/executor.ts";
import type { ExecutableCommand, ShellRunInput } from "../direct/types.ts";
import { fullAlphaSandboxCapabilities, sandboxExecutionFailure, sandboxExecutionMeta } from "./provider.ts";
import type { SandboxCapabilities, SandboxExecutionRequest, SandboxExecutionResult, SandboxProvider } from "./types.ts";
import { createRuntimeError, runtimeSuccess } from "../core/result.ts";

/** Host execution provider. It is intentionally usable without any sandbox CLI. */
export class DirectProvider implements SandboxProvider {
  readonly name = "direct" as const;
  readonly direct: DirectExecutor;

  constructor(options: { readonly direct?: DirectExecutor } = {}) {
    this.direct = options.direct ?? new DirectExecutor();
  }

  capabilities(): SandboxCapabilities {
    return fullAlphaSandboxCapabilities("direct", {
      state: "ready",
      isolationType: "host",
      workspaceMode: "host",
      workspaceModes: ["host"],
      persistence: "filesystem",
      networkControl: "unsupported",
      resourceLimits: false,
      credentialSupport: "named_grants",
      features: { pauseResume: false, checkpoint: false, snapshot: false, fork: false, clone: false, resourceLimits: false },
    });
  }

  async execute(request: SandboxExecutionRequest, context: OperationContext) {
    const effectClass: EffectClass = request.effectClass ?? "destructive";
    if (request.workspaceMode !== undefined && request.workspaceMode !== "host") {
      const error = createRuntimeError({ code: "SANDBOX_WORKSPACE_UNSUPPORTED", message: "The direct provider only supports host workspace execution", retryable: false, effect: "none", details: { provider: this.name, workspaceMode: request.workspaceMode } });
      return sandboxExecutionFailure(error, sandboxExecutionMeta(context, this.name, effectClass));
    }
    if (request.executable !== undefined) {
      const command: ExecutableCommand = {
        executable: request.executable,
        ...(request.args === undefined ? {} : { args: request.args }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.inheritEnvironment === undefined ? {} : { inheritEnvironment: request.inheritEnvironment }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.maxOutputBytes === undefined ? {} : { maxOutputBytes: request.maxOutputBytes }),
      };
      const result = await this.direct.runExecutable(command, context, { effectClass, instrument: false });
      if (!result.ok) return sandboxExecutionFailure(result.error, sandboxExecutionMeta(context, "direct", effectClass, result.meta));
      const data = this.map(result.data, effectClass);
      return runtimeSuccess(data, sandboxExecutionMeta(context, "direct", effectClass, result.meta, data));
    }
    const command: ShellRunInput = {
      command: request.command ?? "",
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.inheritEnvironment === undefined ? {} : { inheritEnvironment: request.inheritEnvironment }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.maxOutputBytes === undefined ? {} : { maxOutputBytes: request.maxOutputBytes }),
    };
    const result = await this.direct.runShell(command, context, { effectClass, instrument: false });
    if (!result.ok) return sandboxExecutionFailure(result.error, sandboxExecutionMeta(context, "direct", effectClass, result.meta));
    const data = this.map(result.data, effectClass);
    return runtimeSuccess(data, sandboxExecutionMeta(context, "direct", effectClass, result.meta, data));
  }

  private map(result: { readonly status: "completed" | "failed" | "cancelled" | "unknown"; readonly effectState: "none" | "unknown" | "applied"; readonly stdout: string; readonly stderr: string; readonly rawOutputBytes: number; readonly returnedOutputBytes: number; readonly truncated: boolean; readonly exitCode?: number; readonly signal?: string; readonly error?: string }, effectClass: EffectClass): SandboxExecutionResult {
    return {
      provider: this.name,
      isolationType: "host",
      workspaceMode: "host",
      status: result.status,
      effectState: effectClass === "read" ? "none" : result.effectState,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      stdout: result.stdout,
      stderr: result.stderr,
      rawOutputBytes: result.rawOutputBytes,
      returnedOutputBytes: result.returnedOutputBytes,
      truncated: result.truncated,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
}

export const DirectExecutionProvider = DirectProvider;
export const DirectExecutionEnvironmentProvider = DirectProvider;
