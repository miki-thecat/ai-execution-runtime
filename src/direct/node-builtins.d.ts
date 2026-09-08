declare module "node:child_process" {
  export interface SpawnOptions {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly shell?: boolean | string;
    readonly detached?: boolean;
    readonly stdio?: readonly ("pipe" | "ignore" | "inherit")[];
  }

  interface ReadableStreamLike {
    on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
  }

  export interface ChildProcessLike {
    readonly pid?: number;
    readonly stdout: ReadableStreamLike | null;
    readonly stderr: ReadableStreamLike | null;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly killed: boolean;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number | null, signal: string | null) => void): this;
    kill(signal?: string | number): boolean;
  }

  export function spawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcessLike;
}

declare module "node:fs" {
  export function openSync(path: string, flags: string): number;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  export function writeSync(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number): number;
  export function closeSync(fd: number): void;
  export function unlinkSync(path: string): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}

declare module "node:process" {
  export const env: Readonly<Record<string, string | undefined>>;
  export const platform: string;
  export function kill(pid: number, signal?: string): boolean;
}
