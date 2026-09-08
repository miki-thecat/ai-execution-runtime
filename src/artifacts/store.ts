import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createArtifactRef, type ArtifactRef } from "../core/ids.ts";
import type { StateStore, StoredArtifactMetadata } from "../state/store.ts";

export const MAX_ARTIFACT_READ_BYTES = 64 * 1024;

export type ArtifactSensitivity = "public" | "internal" | "personal" | "sensitive" | "secret";

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

function validateDigest(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid SHA-256 artifact digest");
  return digest;
}

function digestFromRef(ref: ArtifactRef): string {
  const prefix = "artifact://sha256:";
  if (!ref.startsWith(prefix)) throw new Error("Invalid artifact reference");
  return validateDigest(ref.slice(prefix.length));
}

function maxReadLength(length: number | undefined): number {
  if (length === undefined) return MAX_ARTIFACT_READ_BYTES;
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("length must be a non-negative integer");
  return Math.min(length, MAX_ARTIFACT_READ_BYTES);
}

function readJson(path: string): ArtifactMetadata {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(readFileSync(path)));
  if (parsed === null || typeof parsed !== "object") throw new Error("Invalid artifact metadata");
  const value = parsed as Record<string, unknown>;
  if (typeof value.ref !== "string" || typeof value.digest !== "string" || typeof value.size !== "number" ||
      typeof value.mediaType !== "string" || typeof value.origin !== "string" || typeof value.sensitivity !== "string" ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("Invalid artifact metadata");
  }
  return value as unknown as ArtifactMetadata;
}

/** Local, content-addressed artifact storage for the Full Alpha data root. */
export class FileArtifactStore implements ArtifactStore {
  readonly rootDir: string;
  private readonly state: StateStore | undefined;

  constructor(options: FileArtifactStoreOptions | string = {}) {
    const normalized: FileArtifactStoreOptions = typeof options === "string" ? { rootDir: options } : options;
    this.rootDir = normalized.rootDir ?? join(normalized.dataRoot ?? join(homedir(), ".aer"), "artifacts");
    this.state = normalized.state;
    mkdirSync(join(this.rootDir, "sha256"), { recursive: true });
  }

  put(content: Uint8Array | string, options: ArtifactPutOptions = {}): ArtifactMetadata {
    const bytes = bytesFor(content);
    const digest = digestFor(bytes);
    const ref = createArtifactRef(digest);
    const contentPath = this.contentPath(digest);
    const metadataPath = this.metadataPath(digest);
    if (!existsSync(contentPath)) {
      const temporaryPath = join(this.rootDir, `.tmp-${digest}-${Date.now()}`);
      writeFileSync(temporaryPath, bytes, { flag: "wx" });
      renameSync(temporaryPath, contentPath);
    }
    if (existsSync(metadataPath)) {
      const existing = readJson(metadataPath);
      this.state?.registerArtifact(existing);
      return existing;
    }
    const timestamp = (options.now ?? new Date()).toISOString();
    const metadata: ArtifactMetadata = {
      ref,
      digest,
      size: bytes.byteLength,
      mediaType: options.mediaType ?? "application/octet-stream",
      origin: options.origin ?? "runtime",
      sensitivity: options.sensitivity ?? "internal",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const temporaryMetadataPath = join(this.rootDir, `.tmp-${digest}-${Date.now()}.json`);
    writeFileSync(temporaryMetadataPath, JSON.stringify(metadata), { flag: "wx" });
    renameSync(temporaryMetadataPath, metadataPath);
    this.state?.registerArtifact(metadata);
    return metadata;
  }

  metadata(ref: ArtifactRef): ArtifactMetadata | undefined {
    const digest = digestFromRef(ref);
    const path = this.metadataPath(digest);
    if (this.state !== undefined) {
      const persisted = this.state.getArtifact(ref);
      if (persisted !== undefined) return persisted as ArtifactMetadata;
    }
    return existsSync(path) ? readJson(path) : undefined;
  }

  read(ref: ArtifactRef, options: ArtifactReadOptions = {}): Uint8Array {
    const digest = digestFromRef(ref);
    const path = this.contentPath(digest);
    if (!existsSync(path)) throw new Error(`Artifact not found: ${ref}`);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative integer");
    const length = maxReadLength(options.length ?? options.maxBytes);
    const size = statSync(path).size;
    if (offset >= size || length === 0) return new Uint8Array();
    const result = new Uint8Array(Math.min(length, size - offset));
    const file = openSync(path, "r");
    try {
      let read = 0;
      while (read < result.byteLength) {
        const count = readSync(file, result, read, result.byteLength - read, offset + read);
        if (count === 0) break;
        read += count;
      }
      return read === result.byteLength ? result : result.slice(0, read);
    } finally {
      closeSync(file);
    }
  }

  has(ref: ArtifactRef): boolean {
    return existsSync(this.contentPath(digestFromRef(ref)));
  }

  private contentPath(digest: string): string {
    return join(this.rootDir, "sha256", digest);
  }

  private metadataPath(digest: string): string {
    return join(this.rootDir, "sha256", `${digest}.json`);
  }
}

export function artifactMetadataToState(metadata: ArtifactMetadata): StoredArtifactMetadata {
  return metadata;
}
