export const SENSITIVITIES = ["public", "internal", "personal", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export interface RedactionPolicy {
  readonly captureContent: boolean;
  readonly maxCapturedBytes: number;
  readonly captureSensitivities: readonly Sensitivity[];
  readonly sensitiveKeys: readonly string[];
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = Object.freeze({
  captureContent: false,
  maxCapturedBytes: 16_384,
  captureSensitivities: [],
  sensitiveKeys: [
    "authorization",
    "cookie",
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private_key",
    "prompt",
    "completion",
    "content",
    "stdout",
    "stderr",
    "environment",
    "diff",
  ],
});

export interface RedactedValue {
  readonly redacted: true;
  readonly sensitivity: Sensitivity;
  readonly byteLength: number;
  readonly reason: "content_capture_disabled" | "sensitive_field" | "size_limit";
}

export interface CapturedContent {
  readonly captured: boolean;
  readonly sensitivity: Sensitivity;
  readonly byteLength: number;
  readonly value?: unknown;
  readonly redacted?: RedactedValue;
}

function byteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function redacted(
  value: unknown,
  sensitivity: Sensitivity,
  reason: RedactedValue["reason"],
): RedactedValue {
  return Object.freeze({ redacted: true, sensitivity, byteLength: byteLength(value), reason });
}

function keyIsSensitive(key: string, policy: RedactionPolicy): boolean {
  // Compare key names without separators so snake_case, kebab-case, and
  // camelCase spellings receive the same default protection.
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return policy.sensitiveKeys.some((candidate) =>
    normalized.includes(candidate.toLowerCase().replaceAll(/[^a-z0-9]/g, "")),
  );
}

export class Redactor {
  readonly policy: RedactionPolicy;

  constructor(policy: RedactionPolicy = DEFAULT_REDACTION_POLICY) {
    if (policy.maxCapturedBytes < 0 || !Number.isFinite(policy.maxCapturedBytes)) {
      throw new RangeError("maxCapturedBytes must be finite and non-negative");
    }
    this.policy = policy;
  }

  capture(value: unknown, sensitivity: Sensitivity = "internal"): CapturedContent {
    const size = byteLength(value);
    const allowed =
      this.policy.captureContent &&
      this.policy.captureSensitivities.includes(sensitivity) &&
      size <= this.policy.maxCapturedBytes;

    if (!allowed) {
      const reason = !this.policy.captureContent
        ? "content_capture_disabled"
        : size > this.policy.maxCapturedBytes
          ? "size_limit"
          : "sensitive_field";
      return {
        captured: false,
        sensitivity,
        byteLength: size,
        redacted: redacted(value, sensitivity, reason),
      };
    }

    return { captured: true, sensitivity, byteLength: size, value };
  }

  redact(value: unknown, sensitivity: Sensitivity = "internal"): unknown {
    const captured = this.capture(value, sensitivity);
    return captured.captured ? captured.value : captured.redacted;
  }

  sanitizeMetadata(metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const sanitize = (value: unknown, key?: string): unknown => {
      if (key !== undefined && keyIsSensitive(key, this.policy)) {
        return redacted(value, "secret", "sensitive_field");
      }
      if (Array.isArray(value)) return value.map((item) => sanitize(item));
      if (value !== null && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(value)) {
          result[childKey] = sanitize(childValue, childKey);
        }
        return result;
      }
      return value;
    };

    return Object.freeze(sanitize(metadata) as Record<string, unknown>);
  }
}
