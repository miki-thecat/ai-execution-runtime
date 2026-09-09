import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createArtifactRef, type ArtifactRef } from "../core/ids.ts";
import { createRuntimeError } from "../core/result.ts";
import { isSensitivity, strongestSensitivity, type Sensitivity } from "../observability/redaction.ts";
import type { StateStore, StoredArtifactMetadata } from "../state/store.ts";

export const MAX_ARTIFACT_READ_BYTES = 64 * 1024;
export type ArtifactSensitivity = Sensitivity;

export interface ArtifactMetadata {
  readonly ref: ArtifactRef;
  readonly digest: string;
  readonly size: number;
  readonly mediaType: string;
  readonly origin: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactPutOptions {
  readonly mediaType?: string;
  readonly origin?: string;
  readonly sensitivity?: ArtifactSensitivity;
  readonly now?: Date;
}

export interface ArtifactReadOptions {
  readonly offset?: number;
  /** Reads are capped at MAX_ARTIFACT_READ_BYTES even when a larger length is requested. */
  readonly length?: number;
  /** Alias for length for callers expressing a model-facing byte budget. */
  readonly maxBytes?: number;
}

export interface ArtifactStore {
  put(content: Uint8Array | string, options?: ArtifactPutOptions): ArtifactMetadata;
  metadata(ref: ArtifactRef): ArtifactMetadata | undefined;
  read(ref: ArtifactRef, options?: ArtifactReadOptions): Uint8Array;
  has(ref: ArtifactRef): boolean;
}

export interface FileArtifactStoreOptions {
  /** A content directory. If omitted, dataRoot/artifacts is used. */
  readonly rootDir?: string;
  readonly dataRoot?: string;
  /** Optional durable metadata sink; artifact bytes remain filesystem-owned. */
  readonly state?: StateStore;
}

function bytesFor(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function digestFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function integrityFailure(message: string, details: Readonly<Record<string, unknown>> = {}) {
  return createRuntimeError({ code: "ARTIFACT_INTEGRITY_FAILED", message, retryable: false, effect: "none", details });
}

function validateDigest(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw integrityFailure("Invalid SHA-256 artifact digest");
  return digest;
}

function digestFromRef(ref: ArtifactRef): string {
  const prefix = "artifact://sha256:";
  if (!ref.startsWith(prefix)) throw integrityFailure("Invalid artifact reference", { ref });
  return validateDigest(ref.slice(prefix.length));
}

function maxReadLength(length: number | undefined): number {
  if (length === undefined) return MAX_ARTIFACT_READ_BYTES;
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("length must be a non-negative integer");
  return Math.min(length, MAX_ARTIFACT_READ_BYTES);
}

function readJson(path: string): ArtifactMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(readFileSync(path)));
  } catch {
    throw integrityFailure("Artifact metadata is unreadable");
  }
  if (parsed === null || typeof parsed !== "object") throw integrityFailure("Invalid artifact metadata");
  const value = parsed as Record<string, unknown>;
  if (typeof value.ref !== "string" || typeof value.digest !== "string" || typeof value.size !== "number" ||
      typeof value.mediaType !== "string" || typeof value.origin !== "string" || typeof value.sensitivity !== "string" ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || !isSensitivity(value.sensitivity)) {
    throw integrityFailure("Invalid artifact metadata");
  }
  return value as unknown as ArtifactMetadata;
}

function validateMetadata(metadata: StoredArtifactMetadata, ref: ArtifactRef, digest: string): ArtifactMetadata {
  if (metadata.ref !== ref || metadata.digest !== digest || !Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
      !isSensitivity(metadata.sensitivity)) {
    throw integrityFailure("Artifact metadata does not match its content address", { ref });
  }
  return metadata as ArtifactMetadata;
}

function writePrivateAtomic(path: string, content: string | Uint8Array, root: string): void {
  const temporary = join(root, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Local, content-addressed artifact storage for the Full Alpha data root. */
export class FileArtifactStore implements ArtifactStore {
  readonly rootDir: string;
  private readonly state: StateStore | undefined;

  constructor(options: FileArtifactStoreOptions | string = {}) {
    const normalized: FileArtifactStoreOptions = typeof options === "string" ? { rootDir: options } : options;
    this.rootDir = normalized.rootDir ?? join(normalized.dataRoot ?? join(homedir(), ".aer"), "artifacts");
    this.state = normalized.state;
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.rootDir, "sha256"), { recursive: true, mode: 0o700 });
    chmodSync(this.rootDir, 0o700);
    chmodSync(join(this.rootDir, "sha256"), 0o700);
  }

  put(content: Uint8Array | string, options: ArtifactPutOptions = {}): ArtifactMetadata {
    const bytes = bytesFor(content);
    const digest = digestFor(bytes);
    const ref = createArtifactRef(digest);
    const contentPath = this.contentPath(digest);
    const metadataPath = this.metadataPath(digest);
    const diskMetadata = existsSync(metadataPath) ? validateMetadata(readJson(metadataPath), ref, digest) : undefined;
    const stateValue = this.state?.getArtifact(ref);
    const stateMetadata = stateValue === undefined ? undefined : validateMetadata(stateValue, ref, digest);
    if (diskMetadata !== undefined && stateMetadata !== undefined && diskMetadata.size !== stateMetadata.size) {
      throw integrityFailure("Persisted artifact metadata is inconsistent", { ref });
    }

    if (existsSync(contentPath)) this.readVerified(ref, digest, diskMetadata ?? stateMetadata, 0, 0, bytes.byteLength);
    else writePrivateAtomic(contentPath, bytes, this.rootDir);

    const timestamp = (options.now ?? new Date()).toISOString();
    const previous = diskMetadata === undefined ? stateMetadata : stateMetadata === undefined ? diskMetadata : {
      ...diskMetadata,
      sensitivity: strongestSensitivity(diskMetadata.sensitivity, stateMetadata.sensitivity),
      updatedAt: diskMetadata.updatedAt >= stateMetadata.updatedAt ? diskMetadata.updatedAt : stateMetadata.updatedAt,
    };
    const requestedSensitivity = options.sensitivity ?? "internal";
    const sensitivity = previous === undefined ? requestedSensitivity : strongestSensitivity(previous.sensitivity, requestedSensitivity);
    const metadata: ArtifactMetadata = {
      ref, digest, size: bytes.byteLength,
      mediaType: previous?.mediaType ?? options.mediaType ?? "application/octet-stream",
      origin: previous?.origin ?? options.origin ?? "runtime",
      sensitivity,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: previous === undefined || sensitivity !== previous.sensitivity ? timestamp : previous.updatedAt,
    };
    validateMetadata(metadata, ref, digest);
    if (diskMetadata === undefined || JSON.stringify(diskMetadata) !== JSON.stringify(metadata)) writePrivateAtomic(metadataPath, JSON.stringify(metadata), this.rootDir);
    else chmodSync(metadataPath, 0o600);
    chmodSync(contentPath, 0o600);
    this.state?.registerArtifact(metadata);
    return metadata;
  }

  metadata(ref: ArtifactRef): ArtifactMetadata | undefined {
    const digest = digestFromRef(ref);
    const path = this.metadataPath(digest);
    const disk = existsSync(path) ? validateMetadata(readJson(path), ref, digest) : undefined;
    const persistedValue = this.state?.getArtifact(ref);
    const persisted = persistedValue === undefined ? undefined : validateMetadata(persistedValue, ref, digest);
    if (disk !== undefined && persisted !== undefined && disk.size !== persisted.size) throw integrityFailure("Persisted artifact metadata is inconsistent", { ref });
    if (disk === undefined) return persisted;
    if (persisted === undefined) return disk;
    return { ...disk, sensitivity: strongestSensitivity(disk.sensitivity, persisted.sensitivity) };
  }

  read(ref: ArtifactRef, options: ArtifactReadOptions = {}): Uint8Array {
    const digest = digestFromRef(ref);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative integer");
    const length = maxReadLength(options.length ?? options.maxBytes);
    const metadata = this.metadata(ref);
    if (metadata === undefined) throw integrityFailure("Artifact metadata is missing", { ref });
    return this.readVerified(ref, digest, metadata, offset, length);
  }

  has(ref: ArtifactRef): boolean {
    try { this.read(ref, { length: 0 }); return true; } catch { return false; }
  }

  private readVerified(ref: ArtifactRef, digest: string, metadata: ArtifactMetadata | undefined, offset: number, length: number, expectedSize?: number): Uint8Array {
    const path = this.contentPath(digest);
    let file: number;
    try {
      file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      throw integrityFailure(existsSync(path) ? "Artifact blob cannot be opened safely" : "Artifact blob is missing", { ref, cause: cause instanceof Error ? cause.message : String(cause) });
    }
    try {
      const initial = fstatSync(file);
      if (!initial.isFile()) throw integrityFailure("Artifact blob is not a regular file", { ref });
      if (expectedSize !== undefined && initial.size !== expectedSize) throw integrityFailure("Existing artifact blob has the wrong size", { ref, expectedSize, actualSize: initial.size });
      if (metadata !== undefined && initial.size !== metadata.size) throw integrityFailure("Artifact size does not match metadata", { ref, expectedSize: metadata.size, actualSize: initial.size });
      const resultLength = offset >= initial.size ? 0 : Math.min(length, initial.size - offset);
      const result = new Uint8Array(resultLength);
      const hash = createHash("sha256");
      const buffer = new Uint8Array(MAX_ARTIFACT_READ_BYTES);
      let position = 0;
      while (position < initial.size) {
        const count = readSync(file, buffer, 0, Math.min(buffer.byteLength, initial.size - position), position);
        if (count === 0) throw integrityFailure("Artifact blob ended before its recorded size", { ref });
        const chunk = buffer.subarray(0, count);
        hash.update(chunk);
        const overlapStart = Math.max(position, offset);
        const overlapEnd = Math.min(position + count, offset + resultLength);
        if (overlapEnd > overlapStart) result.set(chunk.subarray(overlapStart - position, overlapEnd - position), overlapStart - offset);
        position += count;
      }
      const final = fstatSync(file);
      if (final.size !== initial.size || hash.digest("hex") !== digest) throw integrityFailure("Artifact blob digest does not match its content address", { ref });
      return result;
    } finally {
      closeSync(file);
    }
  }

  private contentPath(digest: string): string { return join(this.rootDir, "sha256", digest); }
  private metadataPath(digest: string): string { return join(this.rootDir, "sha256", `${digest}.json`); }
}

export function artifactMetadataToState(metadata: ArtifactMetadata): StoredArtifactMetadata { return metadata; }
