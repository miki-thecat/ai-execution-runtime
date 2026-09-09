declare module "node:child_process" {
  export interface SpawnSyncOptions {
    readonly cwd?: string;
    readonly encoding?: "utf8";
    readonly maxBuffer?: number;
  }
  export interface SpawnSyncReturns {
    readonly status: number | null;
    readonly stdout: string | Uint8Array;
    readonly stderr: string | Uint8Array;
    readonly error?: Error;
  }
  export function spawnSync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns;
}

declare module "node:fs" {
  interface FileStats {
    readonly isFile: () => boolean;
    readonly isDirectory: () => boolean;
    readonly isSymbolicLink: () => boolean;
  }
  interface DirectoryEntry {
    readonly name: string;
    readonly isFile: () => boolean;
    readonly isDirectory: () => boolean;
    readonly isSymbolicLink: () => boolean;
  }
  export function lstatSync(path: string): FileStats;
  export function realpathSync(path: string): string;
  export function linkSync(existingPath: string, newPath: string): void;
  export function readdirSync(path: string, options: { readonly withFileTypes: true }): DirectoryEntry[];
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export const sep: string;
  export function basename(path: string): string;
}

declare module "node:process" {
  export const pid: number;
}
