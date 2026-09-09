export const EFFECT_CLASSES = [
  "read",
  "workspace_write",
  "network",
  "remote_write",
  "destructive",
  "privileged",
] as const;

export type EffectClass = (typeof EFFECT_CLASSES)[number];

export const EFFECT_STATES = ["none", "unknown", "applied"] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

export const POLICY_DECISIONS = ["allow", "deny", "approval_required"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export type EffectPolicyProfile = "full_alpha_default" | "permissive_dev_test" | "custom";

export interface CredentialGrant {
  /** The exact environment key which may be exposed. */
  readonly key?: string;
  /** Alias accepted by transport adapters. */
  readonly name?: string;
  /** Optional operation names. An empty list means any explicitly named operation. */
  readonly operations?: readonly string[];
  readonly operation?: string;
  readonly class?: string;
}

export interface EffectPolicy {
  readonly allowedClasses?: readonly EffectClass[];
  readonly approvalRequiredClasses?: readonly EffectClass[];
  /** Ordinary network is configurable independently of high-risk effects. */
  readonly network?: PolicyDecision;
  readonly name?: string;
  readonly profile?: EffectPolicyProfile;
  readonly credentialGrants?: readonly CredentialGrant[];
  /** Evidence used by semantic workspace providers; it is not provider authority. */
  readonly workspaceRoot?: string;
}

export const FULL_ALPHA_DEFAULT_POLICY_NAME = "full-alpha-default" as const;
export const PERMISSIVE_DEV_TEST_POLICY_NAME = "permissive-dev-test" as const;

export function fullAlphaDefaultPolicy(options: { readonly network?: PolicyDecision; readonly workspaceRoot?: string } = {}): EffectPolicy {
  const network = options.network ?? "allow";
  if (network === "approval_required") {
    return {
      name: FULL_ALPHA_DEFAULT_POLICY_NAME,
      profile: "full_alpha_default",
      network,
      allowedClasses: ["read", "workspace_write", "network", "remote_write", "destructive"],
      approvalRequiredClasses: ["remote_write", "destructive", "network"],
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    };
  }
  if (network === "deny") {
    return {
      name: FULL_ALPHA_DEFAULT_POLICY_NAME,
      profile: "full_alpha_default",
      network,
      allowedClasses: ["read", "workspace_write", "remote_write", "destructive"],
      approvalRequiredClasses: ["remote_write", "destructive"],
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    };
  }
  return {
    name: FULL_ALPHA_DEFAULT_POLICY_NAME,
    profile: "full_alpha_default",
    network,
    allowedClasses: ["read", "workspace_write", "network", "remote_write", "destructive"],
    approvalRequiredClasses: ["remote_write", "destructive"],
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
  };
}

export const defaultEffectPolicy = fullAlphaDefaultPolicy;
export const createFullAlphaDefaultPolicy = fullAlphaDefaultPolicy;
export const FULL_ALPHA_DEFAULT_POLICY: EffectPolicy = fullAlphaDefaultPolicy();

/** Explicit opt-in escape hatch for local fixtures and development. */
export const permissiveEffectPolicy = (): EffectPolicy => ({
  name: PERMISSIVE_DEV_TEST_POLICY_NAME,
  profile: "permissive_dev_test",
  network: "allow",
  allowedClasses: [...EFFECT_CLASSES],
  approvalRequiredClasses: [],
});

export interface PolicyDecisionEvidence {
  readonly effectClass: EffectClass;
  readonly decision: PolicyDecision;
  readonly policy: string;
  readonly profile: EffectPolicyProfile;
  readonly reason: string;
  readonly source: "aer";
}

function normalizedPolicy(policy: EffectPolicy | undefined): EffectPolicy {
  if (policy === undefined) return fullAlphaDefaultPolicy();
  if (policy.profile === "permissive_dev_test") return policy;
  const base = fullAlphaDefaultPolicy(policy.network === undefined ? {} : { network: policy.network });
  const allowedClasses = base.allowedClasses ?? [];
  const approvalRequiredClasses = base.approvalRequiredClasses ?? [];
  return {
    ...base,
    ...policy,
    name: policy.name ?? "custom-policy",
    profile: policy.profile ?? "custom",
    allowedClasses: policy.allowedClasses ?? allowedClasses,
    approvalRequiredClasses: policy.approvalRequiredClasses ?? approvalRequiredClasses,
  };
}

export function isEffectAllowed(policy: EffectPolicy | undefined, effectClass: EffectClass): boolean {
  return effectDecision(policy, effectClass) !== "deny";
}

export function requiresApproval(policy: EffectPolicy | undefined, effectClass: EffectClass): boolean {
  return effectDecision(policy, effectClass) === "approval_required";
}

export function effectDecision(policy: EffectPolicy | undefined, effectClass: EffectClass): PolicyDecision {
  const effective = normalizedPolicy(policy);
  if (!(effective.allowedClasses?.includes(effectClass) ?? false)) return "deny";
  if (effective.approvalRequiredClasses?.includes(effectClass) ?? false) return "approval_required";
  if (effectClass === "network" && effective.network !== undefined) return effective.network;
  return "allow";
}

export function policyDecisionEvidence(policy: EffectPolicy | undefined, effectClass: EffectClass): PolicyDecisionEvidence {
  const effective = normalizedPolicy(policy);
  const decision = effectDecision(effective, effectClass);
  const reason = decision === "allow"
    ? `${effectClass} is allowed by ${effective.name ?? "the configured policy"}`
    : decision === "approval_required"
      ? `${effectClass} requires an AER approval decision`
      : `${effectClass} is denied by ${effective.name ?? "the configured policy"}`;
  return {
    effectClass,
    decision,
    policy: effective.name ?? "custom-policy",
    profile: effective.profile ?? "custom",
    reason,
    source: "aer",
  };
}

export const evaluateEffect = policyDecisionEvidence;

export function credentialGrant(policy: EffectPolicy | undefined, key: string, operation: string): CredentialGrant | undefined {
  return normalizedPolicy(policy).credentialGrants?.find((grant) =>
    (grant.key ?? grant.name) === key &&
    (grant.operations === undefined || grant.operations.length === 0 || grant.operations.includes(operation)) &&
    (grant.operation === undefined || grant.operation === operation));
}
