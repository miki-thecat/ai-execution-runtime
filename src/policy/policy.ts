import {
  effectDecision,
  fullAlphaDefaultPolicy,
  policyDecisionEvidence,
  type EffectClass,
  type EffectPolicy,
  type PolicyDecision,
  type PolicyDecisionEvidence,
} from "../core/effects.ts";

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly evidence: PolicyDecisionEvidence;
}

/** Small runtime-owned policy evaluator shared by dispatchers and providers. */
export class EffectPolicyEngine {
  readonly policy: EffectPolicy;

  constructor(policy: EffectPolicy = fullAlphaDefaultPolicy()) {
    this.policy = policy;
  }

  evaluate(effectClass: EffectClass): PolicyEvaluation {
    return { decision: effectDecision(this.policy, effectClass), evidence: policyDecisionEvidence(this.policy, effectClass) };
  }
}

export const evaluatePolicy = (policy: EffectPolicy | undefined, effectClass: EffectClass): PolicyEvaluation => ({
  decision: effectDecision(policy, effectClass),
  evidence: policyDecisionEvidence(policy, effectClass),
});
