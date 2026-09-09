import { createRuntimeError, type OperationContext, type RuntimeError } from "../core/index.ts";
import { DirectExecutor } from "../direct/index.ts";
import type { GitDiffSummary, GitSnapshot } from "./types.ts";

const GIT_OUTPUT_LIMIT = 128 * 1024;

/** Measurements for the direct Git commands making up one live snapshot. */
export interface GitSnapshotMetrics {
  internalCalls: number;
  rawOutputBytes: number;
  returnedOutputBytes: number;
  artifactBytes: number;
}

function text(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function parseNumber(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseShortStat(value: string): { filesChanged: number; insertions: number; deletions: number } {
  const line = text(value);
  const filesChanged = /([\d,]+) files? changed/.exec(line)?.[1];
  const insertions = /([\d,]+) insertions?\(\+\)/.exec(line)?.[1];
  const deletions = /([\d,]+) deletions?\(-\)/.exec(line)?.[1];
  return {
    filesChanged: parseNumber(filesChanged?.replaceAll(",", "")),
    insertions: parseNumber(insertions?.replaceAll(",", "")),
    deletions: parseNumber(deletions?.replaceAll(",", "")),
  };
}

function diffSummary(filesChanged: number, insertions: number, deletions: number, untrackedFiles: number): GitDiffSummary {
  const parts = [`${filesChanged} tracked file${filesChanged === 1 ? "" : "s"} changed`, `+${insertions}/-${deletions} lines`];
  if (untrackedFiles > 0) parts.push(`${untrackedFiles} untracked file${untrackedFiles === 1 ? "" : "s"}`);
  return { filesChanged, insertions, deletions, untrackedFiles, summary: parts.join(", ") };
}

function gitError(cause: unknown): RuntimeError {
  if (cause !== null && typeof cause === "object" && "code" in cause && "message" in cause && "effect" in cause) {
    return cause as RuntimeError;
  }
  return createRuntimeError({
    code: "GIT_COMMAND_FAILED",
    message: cause instanceof Error ? cause.message : "Git command failed",
    retryable: false,
    effect: "none",
  });
}

/**
 * A deliberately small Git provider. Git itself remains the source of truth;
 * this class only compresses read-only Git commands into a live snapshot.
 */
export class LocalGitSnapshot {
  readonly direct: DirectExecutor;

  constructor(options: { readonly direct?: DirectExecutor } = {}) {
    this.direct = options.direct ?? new DirectExecutor();
  }

  async snapshot(rootDir: string, context: OperationContext, metrics?: GitSnapshotMetrics): Promise<GitSnapshot> {
    try {
      const gitRoot = text(await this.command(rootDir, ["rev-parse", "--show-toplevel"], context, metrics));
      const head = text(await this.command(rootDir, ["rev-parse", "HEAD"], context, metrics));
      const branchValue = text(await this.command(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"], context, metrics));
      const status = await this.command(rootDir, ["status", "--porcelain=v1", "--untracked-files=all"], context, metrics);
      const statusLines = text(status) === "" ? [] : text(status).split("\n");
      const untrackedFiles = statusLines.filter((line) => line.startsWith("?? ")).length;
      const dirty = statusLines.length > 0;

      let upstream: string | undefined;
      try {
        upstream = text(await this.command(rootDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], context, metrics)) || undefined;
      } catch {
        // A branch without an upstream is normal and is represented as 0/0.
      }

      let ahead = 0;
      let behind = 0;
      if (upstream !== undefined) {
        try {
          const divergence = text(await this.command(rootDir, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], context, metrics));
          const values = divergence.split(/\s+/);
          ahead = parseNumber(values[0]);
          behind = parseNumber(values[1]);
        } catch {
          // Keep the live snapshot useful when an upstream disappears during inspection.
        }
      }

      let stats = { filesChanged: 0, insertions: 0, deletions: 0 };
      try {
        stats = parseShortStat(await this.command(rootDir, ["diff", "HEAD", "--shortstat"], context, metrics));
      } catch {
        // An unborn repository has no HEAD to diff against.
        try {
          stats = parseShortStat(await this.command(rootDir, ["diff", "--shortstat"], context, metrics));
        } catch {
          // Diff statistics are explicitly best-effort.
        }
      }
      const diff = diffSummary(stats.filesChanged, stats.insertions, stats.deletions, untrackedFiles);
      const branch = branchValue === "" || branchValue === "HEAD" ? undefined : branchValue;
      return {
        available: true,
        root: rootDir,
        gitRoot,
        ...(branch === undefined ? {} : { branch }),
        head,
        dirty,
        ...(upstream === undefined ? {} : { upstream }),
        ahead,
        behind,
        upstreamDivergence: { ahead, behind },
        diff,
        diffSummary: diff,
      };
    } catch (cause) {
      const error = gitError(cause);
      return {
        available: false,
        root: rootDir,
        dirty: false,
        ahead: 0,
        behind: 0,
        upstreamDivergence: { ahead: 0, behind: 0 },
        diff: diffSummary(0, 0, 0, 0),
        diffSummary: diffSummary(0, 0, 0, 0),
        error: error.message,
      };
    }
  }

  /** Alias used by callers that treat this provider as a live Git source. */
  getSnapshot(rootDir: string, context: OperationContext): Promise<GitSnapshot> {
    return this.snapshot(rootDir, context);
  }

  private async command(rootDir: string, args: readonly string[], context: OperationContext, metrics?: GitSnapshotMetrics): Promise<string> {
    if (metrics !== undefined) metrics.internalCalls += 1;
    const result = await this.direct.runExecutable({
      executable: "git",
      args,
      cwd: rootDir,
      maxOutputBytes: GIT_OUTPUT_LIMIT,
    }, context, { instrument: false });
    if (!result.ok) {
      if (metrics !== undefined) {
        metrics.rawOutputBytes += result.meta.metrics.rawOutputBytes;
        metrics.returnedOutputBytes += result.meta.metrics.returnedOutputBytes;
        metrics.artifactBytes += result.meta.metrics.artifactBytes;
      }
      throw result.error;
    }
    if (metrics !== undefined) {
      metrics.rawOutputBytes += result.data.rawOutputBytes;
      metrics.returnedOutputBytes += result.data.returnedOutputBytes;
      metrics.artifactBytes += result.data.artifactBytes;
    }
    if (result.data.exitCode !== 0) {
      throw createRuntimeError({
        code: "GIT_COMMAND_FAILED",
        message: result.data.stderr.trim() || `git ${args.join(" ")} exited with ${String(result.data.exitCode)}`,
        retryable: false,
        effect: "none",
        details: { args: [...args], exitCode: result.data.exitCode },
      });
    }
    return result.data.stdout;
  }
}

export const GitSnapshotProvider = LocalGitSnapshot;
