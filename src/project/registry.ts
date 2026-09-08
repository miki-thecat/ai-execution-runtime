import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { createProjectId, type ProjectId } from "../core/ids.ts";
import type { StateStore } from "../state/store.ts";
import {
  parseProjectConfig,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from "./config.ts";
import type {
  ProjectIdentity,
  ProjectRecordData,
  ProjectRef,
  ProjectRegistrationInput,
} from "./types.ts";

function dataFor(entity: { readonly data?: Readonly<Record<string, unknown>> }): Partial<ProjectRecordData> {
  const data = entity.data;
  if (data === undefined) return {};
  return data as Partial<ProjectRecordData>;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === "" ? fallback : value;
}

/** Local registry for project identity and repository-owned configuration. */
export class ProjectRegistry {
  private readonly state: StateStore | undefined;
  private readonly projects = new Map<ProjectId, ProjectIdentity>();

  constructor(options: { readonly state?: StateStore } = {}) {
    this.state = options.state;
    this.loadPersistedProjects();
  }

  register(input: ProjectRegistrationInput | string): ProjectIdentity {
    const registration: ProjectRegistrationInput = typeof input === "string" ? { rootDir: input } : input;
    const rootDir = this.projectRoot(registration.rootDir);
    const existingConfig = readProjectConfig(rootDir);
    const persisted = this.persistedForRoot(rootDir);
    const suppliedConfig = registration.config === undefined ? {} : { ...registration.config };
    const configCandidate: Record<string, unknown> = {
      ...(existingConfig ?? {}),
      ...suppliedConfig,
      ...(registration.name === undefined ? {} : { name: registration.name }),
      ...(registration.goal === undefined ? {} : { goal: registration.goal }),
      ...(registration.verify === undefined ? {} : { verify: registration.verify }),
      version: 1,
    };
    const requestedId = registration.projectId ?? registration.id;
    const id = requestedId ?? (typeof configCandidate.id === "string" ? configCandidate.id as ProjectId : undefined) ?? persisted?.projectId ?? createProjectId();
    configCandidate.id = id;
    const config = parseProjectConfig(configCandidate);
    const name = nonEmpty(registration.name ?? config.name, basename(rootDir));
    const goal = registration.goal ?? config.goal;
    const shouldWriteConfig = registration.writeConfig ?? (existingConfig === undefined || existingConfig.id === undefined);
    const configPath = projectConfigPath(rootDir);
    if (shouldWriteConfig) writeProjectConfig(rootDir, { ...config, name, ...(goal === undefined ? {} : { goal }) });
    const project: ProjectIdentity = {
      projectId: id,
      id,
      name,
      rootDir,
      root: rootDir,
      configPath,
      ...(goal === undefined ? {} : { goal }),
      config: {
        ...config,
        name,
        ...(goal === undefined ? {} : { goal }),
      },
    };
    this.projects.set(id, project);
    this.persist(project);
    return project;
  }

  /** Register an existing project without creating a configuration file. */
  load(rootDir: string): ProjectIdentity {
    return this.register({ rootDir, writeConfig: false });
  }

  registerProject(input: ProjectRegistrationInput | string): ProjectIdentity {
    return this.register(input);
  }

  get(ref: ProjectRef): ProjectIdentity | undefined {
    if (typeof ref !== "string") {
      const registered = this.projects.get(ref.projectId);
      if (registered !== undefined) return registered;
      return "config" in ref ? ref : undefined;
    }
    const byId = this.projects.get(ref as ProjectId);
    if (byId !== undefined) return byId;
    const normalized = (() => {
      try { return realpathSync(ref); } catch { return ref; }
    })();
    return [...this.projects.values()].find((project) => project.rootDir === normalized);
  }

  require(ref: ProjectRef): ProjectIdentity {
    const project = this.get(ref);
    if (project === undefined) throw new Error(`Project is not registered: ${typeof ref === "string" ? ref : ref.projectId}`);
    return project;
  }

  list(): readonly ProjectIdentity[] {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private projectRoot(rootDir: string): string {
    if (rootDir.trim() === "") throw new Error("Project root cannot be empty");
    const resolved = realpathSync(rootDir);
    if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) throw new Error(`Project root is not a directory: ${rootDir}`);
    return resolved;
  }

  private persistedForRoot(rootDir: string): ProjectIdentity | undefined {
    return [...this.projects.values()].find((project) => project.rootDir === rootDir) ?? (() => {
      if (this.state === undefined) return undefined;
      const entity = this.state.listEntities("projects").find((candidate) => dataFor(candidate).rootDir === rootDir);
      if (entity === undefined) return undefined;
      const data = dataFor(entity);
      return { projectId: entity.id as ProjectId, id: entity.id as ProjectId, name: String(data.name ?? basename(rootDir)), rootDir, root: rootDir, configPath: projectConfigPath(rootDir), config: parseProjectConfig(data.config ?? {}) };
    })();
  }

  private loadPersistedProjects(): void {
    if (this.state === undefined) return;
    for (const entity of this.state.listEntities("projects")) {
      const data = dataFor(entity);
      if (typeof data.rootDir !== "string") continue;
      const rootDir = data.rootDir;
      const config = (() => {
        try { return readProjectConfig(rootDir) ?? parseProjectConfig(data.config ?? {}); } catch { return parseProjectConfig(data.config ?? {}); }
      })();
      const name = config.name ?? (typeof data.name === "string" ? data.name : basename(rootDir));
      const goal = config.goal ?? (typeof data.goal === "string" ? data.goal : undefined);
      this.projects.set(entity.id as ProjectId, {
        projectId: entity.id as ProjectId,
        id: entity.id as ProjectId,
        name,
        rootDir,
        root: rootDir,
        configPath: projectConfigPath(rootDir),
        ...(goal === undefined ? {} : { goal }),
        config,
      });
    }
  }

  private persist(project: ProjectIdentity): void {
    this.state?.saveEntity({
      kind: "projects",
      id: project.projectId,
      status: "registered",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: {
        rootDir: project.rootDir,
        name: project.name,
        ...(project.goal === undefined ? {} : { goal: project.goal }),
        config: project.config,
      },
    });
  }
}
