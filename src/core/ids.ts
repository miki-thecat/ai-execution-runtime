export type BrandedId<Brand extends string> = string & {
  readonly __brand: Brand;
};

export type TraceId = BrandedId<"TraceId">;
export type RunId = BrandedId<"RunId">;
export type SpanId = BrandedId<"SpanId">;
export type TaskId = BrandedId<"TaskId">;
export type OperationId = BrandedId<"OperationId">;
export type EventId = BrandedId<"EventId">;
export type ProjectId = BrandedId<"ProjectId">;
export type DeviceId = BrandedId<"DeviceId">;
export type ArtifactRef = BrandedId<"ArtifactRef">;
export type ChangesetId = BrandedId<"ChangesetId">;
export type VerificationId = BrandedId<"VerificationId">;

function randomPart(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  // The fallback is only for runtimes without Web Crypto. Node 24 uses the
  // UUID path above; the fallback still gives IDs uniqueness for tests and
  // embedded runtimes that provide no crypto implementation.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createPrefixedId<Brand extends string>(prefix: string): BrandedId<Brand> {
  return `${prefix}_${randomPart()}` as BrandedId<Brand>;
}

export const createTraceId = (): TraceId => createPrefixedId<"TraceId">("trace");
export const createRunId = (): RunId => createPrefixedId<"RunId">("run");
export const createSpanId = (): SpanId => createPrefixedId<"SpanId">("span");
export const createTaskId = (): TaskId => createPrefixedId<"TaskId">("task");
export const createOperationId = (): OperationId => createPrefixedId<"OperationId">("op");
export const createEventId = (): EventId => createPrefixedId<"EventId">("evt");
export const createProjectId = (): ProjectId => createPrefixedId<"ProjectId">("project");
export const createDeviceId = (): DeviceId => createPrefixedId<"DeviceId">("device");
export const createChangesetId = (): ChangesetId => createPrefixedId<"ChangesetId">("changeset");
export const createVerificationId = (): VerificationId =>
  createPrefixedId<"VerificationId">("verification");

export const createArtifactRef = (sha256: string): ArtifactRef =>
  `artifact://sha256:${sha256}` as ArtifactRef;
