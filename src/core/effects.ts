export const EFFECT_CLASSES = [
  "none",
  "read",
  "write",
  "destructive",
  "network",
  "remote",
  "approval",
] as const;

export type EffectClass = (typeof EFFECT_CLASSES)[number];

export const EFFECT_STATES = ["none", "unknown", "applied"] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

export interface EffectPolicy {
  readonly allowedClasses?: readonly EffectClass[];
  readonly approvalRequiredClasses?: readonly EffectClass[];
}

export const permissiveEffectPolicy = (): EffectPolicy => ({
  allowedClasses: [...EFFECT_CLASSES],
  approvalRequiredClasses: [],
});

export function isEffectAllowed(policy: EffectPolicy, effectClass: EffectClass): boolean {
  return policy.allowedClasses?.includes(effectClass) ?? true;
}

export function requiresApproval(policy: EffectPolicy, effectClass: EffectClass): boolean {
  return policy.approvalRequiredClasses?.includes(effectClass) ?? false;
}
