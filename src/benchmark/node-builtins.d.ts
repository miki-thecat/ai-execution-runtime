declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void;
}

declare module "node:child_process" {
  export function spawnSync(command: string, args?: readonly string[], options?: { readonly cwd?: string; readonly encoding?: string; readonly timeout?: number; readonly stdio?: readonly ("pipe" | "ignore" | "inherit")[] }): { readonly status: number | null; readonly stdout?: string | Uint8Array; readonly stderr?: string | Uint8Array; readonly error?: Error };
}

declare module "node:process" {
  export const execPath: string;
}
