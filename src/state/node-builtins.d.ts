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
    readonly mode?: number;
  }

  interface WriteFileOptions {
    readonly flag?: string;
    readonly mode?: number;
  }

  interface FileStats {
    readonly size: number;
    readonly mode: number;
    readonly dev: number;
    readonly ino: number;
    readonly birthtimeMs: number;
    readonly mtimeMs: number;
  }

  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: MakeDirectoryOptions): void;
  export function chmodSync(path: string, mode: number): void;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string | number, data: string | Uint8Array, options?: WriteFileOptions): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function statSync(path: string): FileStats;
  export const constants: { readonly O_RDONLY: number; readonly O_NOFOLLOW: number };
  export function openSync(path: string, flags: string | number, mode?: number): number;
  export function fstatSync(fd: number): FileStats;
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
