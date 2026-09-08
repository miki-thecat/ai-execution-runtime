export const CAPABILITIES = [
  "resume",
  "streaming",
  "approval",
  "structured_output",
  "sandbox",
  "network_policy",
  "remote",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type Capabilities = Readonly<Partial<Record<Capability, boolean>>>;

export function hasCapability(capabilities: Capabilities, capability: Capability): boolean {
  return capabilities[capability] === true;
}

export function capabilityMap(
  enabled: readonly Capability[] = [],
): Capabilities {
  return Object.freeze(
    Object.fromEntries(CAPABILITIES.map((name) => [name, enabled.includes(name)])) as Record<
      Capability,
      boolean
    >,
  );
}
