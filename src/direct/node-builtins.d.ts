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

declare module "node:process" {
  export const env: Readonly<Record<string, string | undefined>>;
  export const platform: string;
  export function kill(pid: number, signal?: string): boolean;
}
