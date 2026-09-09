import type { Operation } from "../operations/operation.ts";
import type {
  GitHubCapabilityInput,
  GitHubCapabilities,
  GitHubEffectReceipt,
  GitHubOperationResult,
  GitHubPublishInput,
  GitHubSnapshot,
  GitHubSnapshotInput,
  GitHubWaitInput,
  GitHubWaitResult,
  GitHubWorkInput,
  GitHubWorkSnapshot,
} from "./types.ts";
import { GitHubProvider } from "./provider.ts";

export function createGitHubCapabilitiesOperation(provider: GitHubProvider): Operation<GitHubCapabilityInput, GitHubCapabilities> {
  return {
    name: "github.capabilities",
    effectClass: "read",
    executor: "direct",
    provider: "github",
    execute(input, context): Promise<GitHubOperationResult<GitHubCapabilities>> {
      return provider.capabilities(input, context, { instrument: false });
    },
  };
}

export function createGitHubSnapshotOperation(provider: GitHubProvider): Operation<GitHubSnapshotInput, GitHubSnapshot> {
  return {
    name: "github.snapshot",
    effectClass: "network",
    executor: "direct",
    provider: "github",
    execute(input, context): Promise<GitHubOperationResult<GitHubSnapshot>> {
      return provider.snapshot(input, context, { instrument: false });
    },
  };
}

export function createGitHubWaitOperation(provider: GitHubProvider): Operation<GitHubWaitInput, GitHubWaitResult> {
  return {
    name: "github.wait",
    effectClass: "network",
    executor: "direct",
    provider: "github",
    execute(input, context): Promise<GitHubOperationResult<GitHubWaitResult>> {
      return provider.wait(input, context, { instrument: false });
    },
  };
}

export function createGitHubPublishOperation(provider: GitHubProvider): Operation<GitHubPublishInput, GitHubEffectReceipt> {
  return {
    name: "github.publish",
    effectClass: "remote",
    executor: "direct",
    provider: "github",
    execute(input, context): Promise<GitHubOperationResult<GitHubEffectReceipt>> {
      return provider.publish(input, context, { instrument: false });
    },
  };
}

export function createGitHubWorkOperation(provider: GitHubProvider): Operation<GitHubWorkInput, GitHubWorkSnapshot> {
  return {
    name: "github.work",
    effectClass: "network",
    executor: "direct",
    provider: "github",
    execute(input, context): Promise<GitHubOperationResult<GitHubWorkSnapshot>> {
      return provider.work(input, context, { instrument: false });
    },
  };
}

export function createGitHubOperations(provider: GitHubProvider): readonly Operation<unknown, unknown>[] {
  return [
    createGitHubCapabilitiesOperation(provider) as Operation<unknown, unknown>,
    createGitHubSnapshotOperation(provider) as Operation<unknown, unknown>,
    createGitHubWaitOperation(provider) as Operation<unknown, unknown>,
    createGitHubWorkOperation(provider) as Operation<unknown, unknown>,
    createGitHubPublishOperation(provider) as Operation<unknown, unknown>,
  ];
}
