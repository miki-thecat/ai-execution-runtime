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

export interface EffectPolicy {
  readonly allowedClasses?: readonly EffectClass[];
  readonly approvalRequiredClasses?: readonly EffectClass[];
}

export const permissiveEffectPolicy = (): EffectPolicy => ({
  allowedClasses: [...EFFECT_CLASSES],
  approvalRequiredClasses: [],
});

export function isEffectAllowed(policy: EffectPolicy, effectClass: EffectClass): boolean {
  return effectDecision(policy, effectClass) !== "deny";
}

export function requiresApproval(policy: EffectPolicy, effectClass: EffectClass): boolean {
  return effectDecision(policy, effectClass) === "approval_required";
}

export function effectDecision(policy: EffectPolicy, effectClass: EffectClass): PolicyDecision {
  if (!(policy.allowedClasses?.includes(effectClass) ?? true)) return "deny";
  if (policy.approvalRequiredClasses?.includes(effectClass) ?? false) return "approval_required";
  return "allow";
}
