declare module "node:http" {
  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string): void;
  }
  export interface HttpServer {
    once(event: "error", listener: (error: Error) => void): this;
    listen(port: number, host: string, callback: () => void): this;
    address(): { readonly port: number } | string | null;
    close(callback: (error?: Error) => void): void;
  }
  export function createServer(listener: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): HttpServer;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:process" {
  export const argv: readonly string[];
  export const stdout: { write(value: string): void };
  export const stderr: { write(value: string): void };
  export const versions: { readonly node: string };
  export function cwd(): string;
  export function exit(code?: number): never;
  export let exitCode: number | undefined;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    readonly status: number | null;
    readonly stdout?: string | Uint8Array;
    readonly stderr?: string | Uint8Array;
    readonly error?: Error;
  }
  export function spawnSync(command: string, args?: readonly string[], options?: { readonly encoding?: string; readonly timeout?: number; readonly stdio?: readonly ("pipe" | "ignore" | "inherit")[] }): SpawnSyncResult;
}
