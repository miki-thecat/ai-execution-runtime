import { createHash } from "node:crypto";
import {
  PROJECT_CONFIG_VERSION,
  configuredVerificationCommands,
  type ConfiguredVerification,
  type ProjectConfig,
} from "./config.ts";

export const VERIFICATION_PLAN_VERSION = 1 as const;
export const DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES = 16 * 1024;
export type VerificationExecutionPosture = "host_unisolated";
export type TrustStatus = "trusted" | "changed_untrusted" | "missing";

export interface NormalizedVerificationCheck {
  readonly checkId: string;
  readonly name: string;
  readonly kind: "shell" | "executable";
  readonly command?: string;
  readonly executable?: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface NormalizedVerificationPlan {
  readonly version: typeof VERIFICATION_PLAN_VERSION;
  readonly configVersion: typeof PROJECT_CONFIG_VERSION;
  readonly checks: readonly NormalizedVerificationCheck[];
}

export interface VerificationPlanProvenance {
  readonly source: "registration" | "explicit_update";
  readonly trustedAt: string;
  readonly previousDigest?: string;
}

export interface TrustedVerificationPlan {
  readonly digest: string;
  readonly plan: NormalizedVerificationPlan;
  readonly provenance: VerificationPlanProvenance;
}

/** Copy a trusted plan at registry boundaries so callers never share its runtime-owned object graph. */
export function copyTrustedVerificationPlan(trusted: TrustedVerificationPlan): TrustedVerificationPlan {
  return {
    digest: trusted.digest,
    plan: {
      version: trusted.plan.version,
      configVersion: trusted.plan.configVersion,
      checks: trusted.plan.checks.map((check) => ({
        checkId: check.checkId,
        name: check.name,
        kind: check.kind,
        ...(check.command === undefined ? {} : { command: check.command }),
        ...(check.executable === undefined ? {} : { executable: check.executable }),
        args: [...check.args],
        ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
        ...(check.maxOutputBytes === undefined ? {} : { maxOutputBytes: check.maxOutputBytes }),
      })),
    },
    provenance: {
      source: trusted.provenance.source,
      trustedAt: trusted.provenance.trustedAt,
      ...(trusted.provenance.previousDigest === undefined ? {} : { previousDigest: trusted.provenance.previousDigest }),
    },
  };
}

/** Retain an immutable private snapshot inside the canonical registry. */
export function freezeTrustedVerificationPlan(trusted: TrustedVerificationPlan): TrustedVerificationPlan {
  const snapshot = copyTrustedVerificationPlan(trusted);
  for (const check of snapshot.plan.checks) {
    Object.freeze(check.args);
    Object.freeze(check);
  }
  Object.freeze(snapshot.plan.checks);
  Object.freeze(snapshot.plan);
  Object.freeze(snapshot.provenance);
  return Object.freeze(snapshot);
}

export interface ProjectBoundaryState {
  readonly identity: {
    readonly status: TrustStatus;
    readonly registeredProjectId: string;
    readonly code?: string;
  };
  readonly root: {
    readonly status: TrustStatus;
    readonly registeredRoot: string;
    readonly code?: string;
  };
  readonly verificationPlan: {
    readonly status: TrustStatus;
    readonly trustedDigest?: string;
    readonly proposedDigest?: string;
    readonly provenance?: VerificationPlanProvenance;
    readonly code?: string;
  };
  readonly execution: {
    readonly posture: VerificationExecutionPosture;
  };
}

function displayName(command: ConfiguredVerification, index: number): string {
  if (typeof command === "string") return command.trim().split(/\s+/)[0] ?? `check-${index + 1}`;
  return command.name ?? command.command ?? command.executable ?? `check-${index + 1}`;
}

function executableShape(command: ConfiguredVerification): Omit<NormalizedVerificationCheck, "checkId" | "name"> {
  if (typeof command === "string") return { kind: "shell", command, args: [], maxOutputBytes: DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES };
  if (command.command !== undefined) {
    return {
      kind: "shell",
      command: command.command,
      args: [],
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      maxOutputBytes: command.maxOutputBytes ?? DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES,
    };
  }
  return {
    kind: "executable",
    executable: command.executable ?? "",
    args: [...(command.args ?? [])],
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    maxOutputBytes: command.maxOutputBytes ?? DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES,
  };
}

function stableCheckId(shape: Omit<NormalizedVerificationCheck, "checkId" | "name">, index: number): string {
  const digest = createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
  return `check-${index + 1}-${digest}`;
}

/** Normalize only execution-relevant fields. Names are retained for selection but excluded from trust identity. */
export function normalizeVerificationPlan(config: ProjectConfig): NormalizedVerificationPlan {
  const checks = configuredVerificationCommands(config).map((command, index): NormalizedVerificationCheck => {
    const shape = executableShape(command);
    return { checkId: stableCheckId(shape, index), name: displayName(command, index), ...shape };
  });
  return { version: VERIFICATION_PLAN_VERSION, configVersion: config.version, checks };
}

/** Stable digest of executable, argv, bounds, ordering and relevant config versions. */
export function verificationPlanDigest(plan: NormalizedVerificationPlan): string {
  const executablePlan = {
    version: plan.version,
    configVersion: plan.configVersion,
    checks: plan.checks.map((check) => ({
      kind: check.kind,
      ...(check.command === undefined ? {} : { command: check.command }),
      ...(check.executable === undefined ? {} : { executable: check.executable }),
      args: [...check.args],
      timeoutMs: check.timeoutMs ?? null,
      maxOutputBytes: check.maxOutputBytes ?? DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES,
    })),
  };
  return createHash("sha256").update(JSON.stringify(executablePlan)).digest("hex");
}

export function trustedVerificationPlan(
  config: ProjectConfig,
  source: VerificationPlanProvenance["source"],
  trustedAt: string,
  previousDigest?: string,
): TrustedVerificationPlan | undefined {
  const plan = normalizeVerificationPlan(config);
  if (plan.checks.length === 0) return undefined;
  return {
    digest: verificationPlanDigest(plan),
    plan,
    provenance: { source, trustedAt, ...(previousDigest === undefined ? {} : { previousDigest }) },
  };
}
