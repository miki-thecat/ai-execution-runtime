import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createProjectId, type ProjectId } from "../core/ids.ts";
import type { StateStore } from "../state/store.ts";
import { parseProjectConfig, projectConfigPath, readProjectConfig, writeProjectConfig, type ProjectConfig } from "./config.ts";
import {
  copyTrustedVerificationPlan,
  freezeTrustedVerificationPlan,
  normalizeVerificationPlan,
  trustedVerificationPlan,
  verificationPlanDigest,
  type ProjectBoundaryState,
  type TrustedVerificationPlan,
  type TrustStatus,
} from "./trust.ts";
import type { ProjectIdentity, ProjectRecordData, ProjectRef, ProjectRegistrationInput } from "./types.ts";

function dataFor(entity: { readonly data?: Readonly<Record<string, unknown>> }): Partial<ProjectRecordData> {
  return (entity.data ?? {}) as Partial<ProjectRecordData>;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === "" ? fallback : value;
}

function fingerprint(rootDir: string): { readonly registeredRealRoot: string; readonly rootDevice: string; readonly rootInode: string } {
  const stat = statSync(rootDir);
  return { registeredRealRoot: realpathSync(rootDir), rootDevice: stat.dev.toString(), rootInode: stat.ino.toString() };
}

function status(value: TrustStatus, code?: string): { readonly status: TrustStatus; readonly code?: string } {
  return { status: value, ...(code === undefined ? {} : { code }) };
}

interface CanonicalProjectData {
  readonly projectId: ProjectId;
  readonly rootDir: string;
  readonly name: string;
  readonly goal?: string;
  readonly config: ProjectConfig;
  readonly registeredRealRoot?: string;
  readonly rootDevice?: string;
  readonly rootInode?: string;
  readonly trustedVerificationPlan?: TrustedVerificationPlan;
}

/** Durable registry for canonical identity, physical root and trusted executable verification plans. */
export class ProjectRegistry {
  private readonly state: StateStore | undefined;
  private readonly canonical = new Map<ProjectId, CanonicalProjectData>();

  constructor(options: { readonly state?: StateStore } = {}) {
    this.state = options.state;
    this.loadPersistedProjects();
  }

  register(input: ProjectRegistrationInput | string): ProjectIdentity {
    const registration: ProjectRegistrationInput = typeof input === "string" ? { rootDir: input } : input;
    const rootDir = this.projectRoot(registration.rootDir);
    const persisted = [...this.canonical.values()].find((project) => project.rootDir === rootDir || project.registeredRealRoot === rootDir);

    if (persisted !== undefined) {
      const current = this.refresh(persisted.projectId);
      if (registration.writeConfig === true) {
        if (current.boundary.root.status !== "trusted") throw new Error("PROJECT_ROOT_DRIFT: explicitly reconcile the registered physical root before writing config");
        const existingConfig = readProjectConfig(rootDir);
        const updated = parseProjectConfig({
          ...(existingConfig ?? persisted.config),
          ...(registration.config ?? {}),
          ...(registration.name === undefined ? {} : { name: registration.name }),
          ...(registration.goal === undefined ? {} : { goal: registration.goal }),
          ...(registration.verify === undefined ? {} : { verify: registration.verify }),
          id: persisted.projectId,
          version: 1,
        });
        writeProjectConfig(rootDir, updated);
        const canonical: CanonicalProjectData = {
          ...persisted,
          name: nonEmpty(registration.name ?? updated.name, persisted.name),
          ...(registration.goal === undefined && persisted.goal === undefined ? {} : { goal: registration.goal ?? persisted.goal }),
          config: updated,
        };
        this.canonical.set(persisted.projectId, canonical);
        this.persistCanonical(canonical);
      }
      return this.refresh(persisted.projectId);
    }

    const existingConfig = readProjectConfig(rootDir);
    const shouldWriteConfig = registration.writeConfig ?? (existingConfig === undefined || existingConfig.id === undefined);
    const acceptsOverrides = existingConfig === undefined || shouldWriteConfig;
    const configCandidate: Record<string, unknown> = {
      ...(existingConfig ?? {}),
      ...(acceptsOverrides ? registration.config ?? {} : {}),
      ...(acceptsOverrides && registration.name !== undefined ? { name: registration.name } : {}),
      ...(acceptsOverrides && registration.goal !== undefined ? { goal: registration.goal } : {}),
      ...(acceptsOverrides && registration.verify !== undefined ? { verify: registration.verify } : {}),
      version: 1,
    };
    const requestedId = acceptsOverrides ? registration.projectId ?? registration.id : undefined;
    const projectId = requestedId ?? (typeof configCandidate.id === "string" ? configCandidate.id as ProjectId : undefined) ?? createProjectId();
    const duplicate = this.canonical.get(projectId);
    if (duplicate !== undefined) throw new Error(`PROJECT_ID_ALREADY_REGISTERED: ${projectId} belongs to ${duplicate.rootDir}`);
    configCandidate.id = projectId;
    const parsed = parseProjectConfig(configCandidate);
    const name = acceptsOverrides ? nonEmpty(registration.name ?? parsed.name, basename(rootDir)) : nonEmpty(parsed.name, basename(rootDir));
    const goal = acceptsOverrides ? registration.goal ?? parsed.goal : parsed.goal;
    const config = parseProjectConfig({ ...parsed, id: projectId, name, ...(goal === undefined ? {} : { goal }) });
    if (shouldWriteConfig) writeProjectConfig(rootDir, config);
    const physical = fingerprint(rootDir);
    const proposedPlan = trustedVerificationPlan(config, "registration", new Date().toISOString());
    const plan = proposedPlan === undefined ? undefined : freezeTrustedVerificationPlan(proposedPlan);
    const canonical: CanonicalProjectData = {
      projectId,
      rootDir,
      name,
      ...(goal === undefined ? {} : { goal }),
      config,
      ...physical,
      ...(plan === undefined ? {} : { trustedVerificationPlan: plan }),
    };
    this.canonical.set(projectId, canonical);
    this.persistCanonical(canonical);
    return this.refresh(projectId);
  }

  /** Register an existing project without creating a configuration file. */
  load(rootDir: string): ProjectIdentity { return this.register({ rootDir, writeConfig: false }); }
  registerProject(input: ProjectRegistrationInput | string): ProjectIdentity { return this.register(input); }

  /** Explicitly replace the runtime-owned executable plan with the current confined repository proposal. */
  trustVerificationPlan(ref: ProjectRef): ProjectIdentity {
    const project = this.require(ref);
    if (project.boundary.root.status !== "trusted") throw new Error("PROJECT_ROOT_DRIFT: registered physical root must be reconciled first");
    if (project.boundary.identity.status !== "trusted") throw new Error("PROJECT_IDENTITY_DRIFT: repository config.id must match the registered project ID");
    const config = readProjectConfig(project.rootDir);
    if (config === undefined) throw new Error("PROJECT_CONFIG_MISSING: no verification plan is available to trust");
    const canonical = this.canonical.get(project.projectId)!;
    const proposedPlan = trustedVerificationPlan(config, "explicit_update", new Date().toISOString(), canonical.trustedVerificationPlan?.digest);
    const next = proposedPlan === undefined ? undefined : freezeTrustedVerificationPlan(proposedPlan);
    const { trustedVerificationPlan: _previous, ...withoutPlan } = canonical;
    const updated: CanonicalProjectData = { ...withoutPlan, config, ...(next === undefined ? {} : { trustedVerificationPlan: next }) };
    this.canonical.set(project.projectId, updated);
    this.persistCanonical(updated);
    return this.refresh(project.projectId);
  }

  updateTrustedVerificationPlan(ref: ProjectRef): ProjectIdentity { return this.trustVerificationPlan(ref); }

  /** Explicitly acknowledge a replacement/moved physical root for an existing durable project ID. */
  reconcileRoot(ref: ProjectRef, rootDir?: string): ProjectIdentity {
    const projectId = typeof ref === "string" ? (this.canonical.has(ref as ProjectId) ? ref as ProjectId : undefined) : ref.projectId;
    if (projectId === undefined) throw new Error(`Project is not registered: ${String(ref)}`);
    const canonical = this.canonical.get(projectId);
    if (canonical === undefined) throw new Error(`Project is not registered: ${projectId}`);
    const nextRoot = this.projectRoot(rootDir ?? canonical.rootDir);
    const config = readProjectConfig(nextRoot);
    if (config === undefined || config.id !== projectId) throw new Error("PROJECT_IDENTITY_DRIFT: reconciled root config.id must match the durable project ID");
    const updated: CanonicalProjectData = { ...canonical, rootDir: nextRoot, config, ...fingerprint(nextRoot) };
    this.canonical.set(projectId, updated);
    this.persistCanonical(updated);
    return this.refresh(projectId);
  }

  get(ref: ProjectRef): ProjectIdentity | undefined {
    let projectId: ProjectId | undefined;
    if (typeof ref !== "string") projectId = this.canonical.has(ref.projectId) ? ref.projectId : undefined;
    else if (this.canonical.has(ref as ProjectId)) projectId = ref as ProjectId;
    else {
      const lexical = resolve(ref);
      projectId = [...this.canonical.values()].find((project) => project.rootDir === lexical || project.registeredRealRoot === lexical)?.projectId;
      if (projectId === undefined) {
        try {
          const physical = realpathSync(ref);
          projectId = [...this.canonical.values()].find((project) => project.rootDir === physical || project.registeredRealRoot === physical)?.projectId;
        } catch { /* an unknown path is not a registered project */ }
      }
    }
    return projectId === undefined ? undefined : this.refresh(projectId);
  }

  require(ref: ProjectRef): ProjectIdentity {
    const project = this.get(ref);
    if (project === undefined) throw new Error(`Project is not registered: ${typeof ref === "string" ? ref : ref.projectId}`);
    return project;
  }

  list(): readonly ProjectIdentity[] {
    return [...this.canonical.keys()].map((id) => this.refresh(id)).sort((a, b) => a.name.localeCompare(b.name));
  }

  private projectRoot(rootDir: string): string {
    if (rootDir.trim() === "") throw new Error("Project root cannot be empty");
    const resolved = realpathSync(rootDir);
    if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) throw new Error(`Project root is not a directory: ${rootDir}`);
    return resolved;
  }

  private refresh(projectId: ProjectId): ProjectIdentity {
    const canonical = this.canonical.get(projectId);
    if (canonical === undefined) throw new Error(`Project is not registered: ${projectId}`);
    let rootState = status("trusted" as const);
    let config: ProjectConfig | undefined;
    let configError: string | undefined;
    try {
      if (lstatSync(canonical.rootDir).isSymbolicLink()) throw new Error("PROJECT_ROOT_SYMLINK");
      const physical = fingerprint(canonical.rootDir);
      if (canonical.registeredRealRoot === undefined || canonical.rootDevice === undefined || canonical.rootInode === undefined) {
        rootState = status("missing", "PROJECT_ROOT_PROVENANCE_MISSING");
      } else if (physical.registeredRealRoot !== canonical.registeredRealRoot || physical.rootDevice !== canonical.rootDevice || physical.rootInode !== canonical.rootInode) {
        rootState = status("changed_untrusted", "PROJECT_ROOT_DRIFT");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "PROJECT_ROOT_DRIFT";
      rootState = status("changed_untrusted", message.startsWith("PROJECT_") ? message.split(":")[0] : "PROJECT_ROOT_DRIFT");
    }
    if (rootState.status === "trusted") {
      try { config = readProjectConfig(canonical.rootDir); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : "PROJECT_CONFIG_INVALID";
        configError = message.startsWith("PROJECT_") ? message.split(":")[0] : "PROJECT_CONFIG_INVALID";
      }
    }

    let identityState = status("changed_untrusted" as const, "PROJECT_ROOT_DRIFT");
    let planState: ProjectBoundaryState["verificationPlan"] = {
      status: canonical.trustedVerificationPlan === undefined ? "missing" : "changed_untrusted",
      ...(canonical.trustedVerificationPlan === undefined ? {} : { trustedDigest: canonical.trustedVerificationPlan.digest, provenance: { ...canonical.trustedVerificationPlan.provenance } }),
      code: "PROJECT_ROOT_DRIFT",
    };
    if (rootState.status === "trusted") {
      if (config === undefined) {
        const code = configError ?? "PROJECT_CONFIG_MISSING";
        identityState = status(configError === undefined ? "missing" : "changed_untrusted", code);
        planState = { status: canonical.trustedVerificationPlan === undefined ? "missing" : "changed_untrusted", ...(canonical.trustedVerificationPlan === undefined ? {} : { trustedDigest: canonical.trustedVerificationPlan.digest, provenance: { ...canonical.trustedVerificationPlan.provenance } }), code };
      } else {
        identityState = config.id === undefined ? status("missing", "PROJECT_CONFIG_ID_MISSING") : config.id === projectId ? status("trusted") : status("changed_untrusted", "PROJECT_IDENTITY_DRIFT");
        const proposedDigest = verificationPlanDigest(normalizeVerificationPlan(config));
        const trusted = canonical.trustedVerificationPlan;
        const trustedPlanValid = trusted === undefined ? false : verificationPlanDigest(trusted.plan) === trusted.digest;
        planState = trusted === undefined
          ? { status: "missing", proposedDigest, code: "TRUSTED_VERIFICATION_PLAN_MISSING" }
          : !trustedPlanValid
            ? { status: "changed_untrusted", trustedDigest: trusted.digest, proposedDigest, provenance: { ...trusted.provenance }, code: "TRUSTED_VERIFICATION_PLAN_INVALID" }
          : proposedDigest === trusted.digest
            ? { status: "trusted", trustedDigest: trusted.digest, proposedDigest, provenance: { ...trusted.provenance } }
            : { status: "changed_untrusted", trustedDigest: trusted.digest, proposedDigest, provenance: { ...trusted.provenance }, code: "VERIFICATION_PLAN_DRIFT" };
      }
    }
    const boundary: ProjectBoundaryState = {
      identity: { ...identityState, registeredProjectId: projectId },
      root: { ...rootState, registeredRoot: canonical.rootDir },
      verificationPlan: planState,
      execution: { posture: "host_unisolated" },
    };
    const project: ProjectIdentity = {
      projectId,
      id: projectId,
      name: canonical.name,
      rootDir: canonical.rootDir,
      root: canonical.rootDir,
      configPath: projectConfigPath(canonical.rootDir),
      ...(canonical.goal === undefined ? {} : { goal: canonical.goal }),
      config: config ?? canonical.config,
      boundary,
      ...(canonical.trustedVerificationPlan === undefined ? {} : { trustedVerificationPlan: copyTrustedVerificationPlan(canonical.trustedVerificationPlan) }),
    };
    return project;
  }

  private loadPersistedProjects(): void {
    if (this.state === undefined) return;
    for (const entity of this.state.listEntities("projects")) {
      const data = dataFor(entity);
      if (typeof data.rootDir !== "string") continue;
      const config = parseProjectConfig(data.config ?? {});
      const projectId = entity.id as ProjectId;
      this.canonical.set(projectId, {
        projectId,
        rootDir: data.rootDir,
        name: typeof data.name === "string" ? data.name : config.name ?? basename(data.rootDir),
        ...(typeof data.goal === "string" ? { goal: data.goal } : {}),
        config,
        ...(typeof data.registeredRealRoot === "string" ? { registeredRealRoot: data.registeredRealRoot } : {}),
        ...(typeof data.rootDevice === "string" ? { rootDevice: data.rootDevice } : {}),
        ...(typeof data.rootInode === "string" ? { rootInode: data.rootInode } : {}),
        ...(data.trustedVerificationPlan === undefined ? {} : { trustedVerificationPlan: freezeTrustedVerificationPlan(data.trustedVerificationPlan) }),
      });
    }
    for (const id of this.canonical.keys()) this.refresh(id);
  }

  private persistCanonical(project: CanonicalProjectData): void {
    const existing = this.state?.getEntity("projects", project.projectId);
    const now = new Date().toISOString();
    this.state?.saveEntity({
      kind: "projects",
      id: project.projectId,
      status: "registered",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      data: {
        rootDir: project.rootDir,
        name: project.name,
        ...(project.goal === undefined ? {} : { goal: project.goal }),
        config: project.config,
        ...(project.registeredRealRoot === undefined ? {} : { registeredRealRoot: project.registeredRealRoot }),
        ...(project.rootDevice === undefined ? {} : { rootDevice: project.rootDevice }),
        ...(project.rootInode === undefined ? {} : { rootInode: project.rootInode }),
        ...(project.trustedVerificationPlan === undefined ? {} : { trustedVerificationPlan: project.trustedVerificationPlan }),
      },
    });
  }
}
