import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pid, platform } from "node:process";

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

function assertWithinRoot(rootDir: string, candidate: string): void {
  const pathFromRoot = relative(resolve(rootDir), resolve(candidate));
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("PROJECT_CONFIG_ESCAPE: .aer/project.json resolves outside the registered project root");
  }
}

function causeCode(cause: unknown): string {
  return cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
}

/** Keep both root and .aer descriptors open while accessing project.json. */
function withConfinedConfigDirectory<T>(rootDir: string, forWrite: boolean, action: (directory: string, physicalRoot: string) => T): T | undefined {
  if (platform !== "linux") throw new Error("PROJECT_CONFIG_CONFINEMENT_UNSUPPORTED: race-resistant project config access requires Linux /proc descriptor anchoring");
  const physicalRoot = realpathSync(rootDir);
  let rootFd: number;
  try {
    rootFd = openSync(rootDir, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (causeCode(cause) === "ELOOP") throw new Error("PROJECT_ROOT_SYMLINK: registered project root must not be a symbolic link");
    throw cause;
  }
  try {
    const anchoredRoot = `/proc/self/fd/${rootFd}`;
    if (realpathSync(anchoredRoot) !== physicalRoot) throw new Error("PROJECT_ROOT_DRIFT: registered project root changed during config access");
    const directory = join(anchoredRoot, PROJECT_CONFIG_DIRECTORY);
    if (forWrite) {
      try { mkdirSync(directory); }
      catch (cause) { if (causeCode(cause) !== "EEXIST") throw cause; }
    }
    let directoryFd: number;
    try {
      directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if (!forWrite && causeCode(cause) === "ENOENT") return undefined;
      if (causeCode(cause) === "ELOOP") throw new Error("PROJECT_CONFIG_SYMLINK: .aer must not be a symbolic link");
      throw cause;
    }
    try {
      const anchoredDirectory = `/proc/self/fd/${directoryFd}`;
      assertWithinRoot(physicalRoot, realpathSync(anchoredDirectory));
      return action(anchoredDirectory, physicalRoot);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    closeSync(rootFd);
  }
}

function readOpenedFile(file: number): Uint8Array {
  const initial = fstatSync(file);
  if (!initial.isFile()) throw new Error("PROJECT_CONFIG_INVALID: .aer/project.json must be a regular file");
  const bytes = new Uint8Array(initial.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(file, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) throw new Error("PROJECT_CONFIG_READ_RACE: .aer/project.json changed while being read");
    offset += count;
  }
  const final = fstatSync(file);
  if (final.size !== initial.size || final.dev !== initial.dev || final.ino !== initial.ino) {
    throw new Error("PROJECT_CONFIG_READ_RACE: .aer/project.json changed while being read");
  }
  return bytes;
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
  return withConfinedConfigDirectory(rootDir, false, (directory, physicalRoot) => {
    const path = join(directory, PROJECT_CONFIG_FILENAME);
    let file: number;
    try {
      file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if (causeCode(cause) === "ENOENT") return undefined;
      if (causeCode(cause) === "ELOOP") throw new Error("PROJECT_CONFIG_SYMLINK: .aer/project.json must not be a symbolic link");
      throw cause;
    }
    try {
      assertWithinRoot(physicalRoot, realpathSync(`/proc/self/fd/${file}`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(readOpenedFile(file))) as unknown;
      } catch (cause) {
        if (cause instanceof Error && cause.message.startsWith("PROJECT_")) throw cause;
        throw new Error(`Could not read ${projectConfigPath(rootDir)}: ${cause instanceof Error ? cause.message : "invalid JSON"}`);
      }
      return parseProjectConfig(parsed);
    } finally {
      closeSync(file);
    }
  });
}

/** Write only project configuration; mutable task/run state never enters this file. */
export function createProjectConfig(input: ProjectConfigInput = {}): ProjectConfig {
  return parseProjectConfig({ ...input, version: PROJECT_CONFIG_VERSION });
}

export function writeProjectConfig(rootDir: string, config: ProjectConfigInput): string {
  const normalized = createProjectConfig(config);
  const lexicalPath = projectConfigPath(rootDir);
  withConfinedConfigDirectory(rootDir, true, (directory) => {
    const destination = join(directory, PROJECT_CONFIG_FILENAME);
    let destinationStat: ReturnType<typeof lstatSync> | undefined;
    try { destinationStat = lstatSync(destination); } catch (cause) { if (causeCode(cause) !== "ENOENT") throw cause; }
    if (destinationStat?.isSymbolicLink() === true) throw new Error("PROJECT_CONFIG_SYMLINK: .aer/project.json must not be a symbolic link");
    const temporary = join(directory, `.project.json.tmp-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  });
  return lexicalPath;
}

export function configuredVerificationCommands(config: ProjectConfig): readonly ConfiguredVerification[] {
  return config.verify === undefined ? [] : [...config.verify];
}
