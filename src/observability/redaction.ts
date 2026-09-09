export const SENSITIVITIES = ["public", "internal", "personal", "sensitive", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const MAX_DURABLE_TEXT_BYTES = 1_024;

const SENSITIVITY_RANK = new Map<Sensitivity, number>(SENSITIVITIES.map((value, index) => [value, index]));

export function strongestSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  return (SENSITIVITY_RANK.get(left) ?? -1) >= (SENSITIVITY_RANK.get(right) ?? -1) ? left : right;
}

export function isSensitivity(value: string): value is Sensitivity {
  return SENSITIVITY_RANK.has(value as Sensitivity);
}

/** Defense-in-depth for short durable labels; provider output must still stay out of summaries. */
export function sanitizeDurableText(value: string, maxBytes = MAX_DURABLE_TEXT_BYTES): string {
  let sanitized = value
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
  const encoded = new TextEncoder().encode(sanitized);
  if (encoded.byteLength <= maxBytes) return sanitized;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  sanitized = new TextDecoder().decode(encoded.slice(0, end));
  return `${sanitized}…`;
}

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
    "command",
    "executable",
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
      return typeof value === "string" ? sanitizeDurableText(value) : value;
    };

    return Object.freeze(sanitize(metadata) as Record<string, unknown>);
  }
}
