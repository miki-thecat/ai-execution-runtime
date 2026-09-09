import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The versioned, repository-owned part of an AER project. */
export const PROJECT_CONFIG_VERSION = 1 as const;
export const PROJECT_CONFIG_DIRECTORY = ".aer";
export const PROJECT_CONFIG_FILENAME = "project.json";

export interface VerificationCommandConfig {
  /** A stable, model-facing name for this check. */
  readonly name?: string;
  /** A shell command. Shell commands are intentionally project configuration. */
  readonly command?: string;
  /** An argv-form command for projects that do not need a shell. */
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export type ConfiguredVerification = string | VerificationCommandConfig;

export interface ProjectConfig {
  readonly version: typeof PROJECT_CONFIG_VERSION;
  readonly id?: string;
  readonly name?: string;
  readonly goal?: string;
  /** Canonical shorthand from the architecture contract. */
  readonly verify?: readonly ConfiguredVerification[];
  readonly [key: string]: unknown;
}

export interface ProjectConfigInput {
  readonly id?: string;
  readonly name?: string;
  readonly goal?: string;
  readonly verify?: readonly ConfiguredVerification[];
  readonly [key: string]: unknown;
}

export function projectConfigPath(rootDir: string): string {
  return join(rootDir, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_FILENAME);
}

function nonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Project config ${field} must be a non-empty string`);
  return value;
}

function validateVerification(value: unknown): readonly ConfiguredVerification[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Project config verify must be an array");
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      if (entry.trim() === "") throw new Error(`Project config verify[${index}] must not be empty`);
      return entry;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Project config verify[${index}] must be a command string or object`);
    }
    const candidate = entry as Record<string, unknown>;
    const command = nonEmptyString(candidate.command, `verify[${index}].command`);
    const executable = nonEmptyString(candidate.executable, `verify[${index}].executable`);
    if (command === undefined && executable === undefined) {
      throw new Error(`Project config verify[${index}] requires command or executable`);
    }
    if (command !== undefined && executable !== undefined) {
      throw new Error(`Project config verify[${index}] cannot contain both command and executable`);
    }
    if (candidate.name !== undefined) nonEmptyString(candidate.name, `verify[${index}].name`);
    if (candidate.args !== undefined && (!Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === "string"))) {
      throw new Error(`Project config verify[${index}].args must be an array of strings`);
    }
    for (const field of ["timeoutMs", "maxOutputBytes"] as const) {
      const number = candidate[field];
      if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)) {
        throw new Error(`Project config verify[${index}].${field} must be a non-negative integer`);
      }
    }
    return {
      ...(candidate.name === undefined ? {} : { name: candidate.name as string }),
      ...(command === undefined ? {} : { command }),
      ...(executable === undefined ? {} : { executable }),
      ...(candidate.args === undefined ? {} : { args: [...candidate.args as string[]] }),
      ...(candidate.timeoutMs === undefined ? {} : { timeoutMs: candidate.timeoutMs as number }),
      ...(candidate.maxOutputBytes === undefined ? {} : { maxOutputBytes: candidate.maxOutputBytes as number }),
    };
  });
}

/** Validate JSON loaded from a committed .aer/project.json file. */
export function parseProjectConfig(value: unknown): ProjectConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project config must be a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== undefined && candidate.version !== PROJECT_CONFIG_VERSION) {
    throw new Error(`Unsupported project config version: ${String(candidate.version)}`);
  }
  const verify = validateVerification(candidate.verify);
  const result: Record<string, unknown> = { ...candidate, version: PROJECT_CONFIG_VERSION };
  const id = nonEmptyString(candidate.id, "id");
  const name = nonEmptyString(candidate.name, "name");
  const goal = nonEmptyString(candidate.goal, "goal");
  if (id === undefined) delete result.id;
  else result.id = id;
  if (name === undefined) delete result.name;
  else result.name = name;
  if (goal === undefined) delete result.goal;
  else result.goal = goal;
  if (verify === undefined) delete result.verify;
  else result.verify = verify;
  return result as ProjectConfig;
}

export function readProjectConfig(rootDir: string): ProjectConfig | undefined {
  const path = projectConfigPath(rootDir);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(readFileSync(path))) as unknown;
  } catch (cause) {
    throw new Error(`Could not read ${path}: ${cause instanceof Error ? cause.message : "invalid JSON"}`);
  }
  return parseProjectConfig(parsed);
}

/** Write only project configuration; mutable task/run state never enters this file. */
export function createProjectConfig(input: ProjectConfigInput = {}): ProjectConfig {
  return parseProjectConfig({ ...input, version: PROJECT_CONFIG_VERSION });
}

export function writeProjectConfig(rootDir: string, config: ProjectConfigInput): string {
  const normalized = createProjectConfig(config);
  const path = projectConfigPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return path;
}

export function configuredVerificationCommands(config: ProjectConfig): readonly ConfiguredVerification[] {
  return config.verify === undefined ? [] : [...config.verify];
}
