declare module "node:sqlite" {
  interface StatementResult {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...parameters: unknown[]): StatementResult;
    get(...parameters: unknown[]): Record<string, unknown> | undefined;
    all(...parameters: unknown[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(location: string, options?: Readonly<Record<string, unknown>>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }

  export function createHash(algorithm: string): Hash;
}

declare module "node:fs" {
  interface MakeDirectoryOptions {
    readonly recursive?: boolean;
  }

  interface WriteFileOptions {
    readonly flag?: string;
    readonly mode?: number;
  }

  interface FileStats {
    readonly size: number;
    readonly birthtimeMs: number;
    readonly mtimeMs: number;
  }

  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: MakeDirectoryOptions): void;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: WriteFileOptions): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function statSync(path: string): FileStats;
  export function openSync(path: string, flags: string): number;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  export function closeSync(fd: number): void;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:os" {
  export function homedir(): string;
}
