import { env as parentEnvironment } from "node:process";
import type { CredentialGrant, EffectPolicy } from "../core/effects.ts";

export const SAFE_BASELINE_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "CI",
] as const;

const SAFE_ORDINARY_ENVIRONMENT = /^(?:SHELL|HOSTNAME|LANGUAGE|TZ|COLORTERM|FORCE_COLOR|CONTINUOUS_INTEGRATION)$/i;
const DEFAULT_CREDENTIAL_CLASSIFIERS: readonly CredentialClassifier[] = [
  { name: "token", pattern: /token/i },
  { name: "secret", pattern: /secret/i },
  { name: "password", pattern: /pass(word)?/i },
  { name: "api_key", pattern: /api[_-]?key|apikey/i },
  { name: "credential", pattern: /credential|auth/i },
  { name: "private_key", pattern: /private[_-]?key/i },
  { name: "cookie", pattern: /cookie/i },
  { name: "github_credential", pattern: /^GH_|GITHUB_|github/i },
  { name: "cloud_credential", pattern: /^(AWS|AZURE|GOOGLE|GCLOUD|CLOUD)_/i },
  { name: "cluster_credential", pattern: /KUBECONFIG|KUBE_/i },
  { name: "database_credential", pattern: /DATABASE_URL|DB_PASSWORD/i },
  { name: "credential_file", pattern: /NPM_CONFIG_USERCONFIG|GIT_ASKPASS|NETRC|SSH_AUTH_SOCK|DOCKER_CONFIG|APPLICATION_CREDENTIALS/i },
  { name: "runtime_control", pattern: /^(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_|NODE_OPTIONS|BASH_ENV|ENV|PYTHONPATH|PERL5LIB|RUBYLIB|CLASSPATH)$/i },
];

export interface CredentialClassifier {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface ChildEnvironmentRequest {
  readonly operation: string;
  readonly values?: Readonly<Record<string, string | undefined>>;
  /** Compatibility input; it never permits ambient inheritance. */
  readonly inheritEnvironment?: boolean;
  readonly policy?: EffectPolicy;
  readonly classifiers?: readonly CredentialClassifier[];
  readonly providerKeys?: readonly string[];
}

export interface EnvironmentEvidence {
  readonly baselineKeys: readonly string[];
  readonly granted: readonly EnvironmentKeyEvidence[];
  readonly withheld: readonly EnvironmentKeyEvidence[];
  readonly valueLogging: "disabled";
}

export interface EnvironmentKeyEvidence {
  readonly key: string;
  readonly class: string;
}

export interface ChildEnvironment {
  readonly values: Readonly<Record<string, string | undefined>>;
  readonly evidence: EnvironmentEvidence;
}

function classify(key: string, classifiers: readonly CredentialClassifier[]): string | undefined {
  return classifiers.find((classifier) => classifier.pattern.test(key))?.name;
}

function evidence(key: string, classifiers: readonly CredentialClassifier[]): EnvironmentKeyEvidence {
  return { key, class: classify(key, classifiers) ?? "ordinary" };
}

function granted(grants: readonly CredentialGrant[], key: string, operation: string): CredentialGrant | undefined {
  return grants.find((grant) => {
    const grantKey = grant.key ?? grant.name;
    const operations = grant.operations ?? (grant.operation === undefined ? undefined : [grant.operation]);
    return grantKey === key && (operations === undefined || operations.length === 0 || operations.includes(operation));
  });
}

/** Build a child environment from an allow-listed baseline. `inheritEnvironment` is deliberately ignored. */
export function buildChildEnvironment(request: ChildEnvironmentRequest): ChildEnvironment {
  const classifiers = [...DEFAULT_CREDENTIAL_CLASSIFIERS, ...(request.classifiers ?? [])];
  const policy = request.policy;
  const grants = policy?.credentialGrants ?? [];
  const values: Record<string, string | undefined> = {};
  const baselineKeys: string[] = [];
  for (const key of SAFE_BASELINE_ENVIRONMENT_KEYS) {
    if (parentEnvironment[key] !== undefined) {
      values[key] = parentEnvironment[key];
      baselineKeys.push(key);
    }
  }
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (value !== undefined && SAFE_ORDINARY_ENVIRONMENT.test(key) && classify(key, classifiers) === undefined) values[key] = value;
  }

  const supplied = request.values ?? {};
  for (const [key, value] of Object.entries(supplied)) {
    const classification = classify(key, classifiers);
    // A credential key is never accepted from an arbitrary env map. It must
    // be an exact, operation-scoped policy grant.
    if (classification !== undefined && granted(grants, key, request.operation) === undefined) continue;
    values[key] = value;
  }
  for (const key of request.providerKeys ?? []) {
    const grant = granted(grants, key, request.operation);
    if (grant !== undefined && parentEnvironment[key] !== undefined) values[key] = parentEnvironment[key];
  }
  // A policy grant is itself the explicit request to expose the named
  // ambient credential; it is still limited to the named operation.
  for (const grant of grants) {
    const key = grant.key ?? grant.name;
    if (key !== undefined && granted(grants, key, request.operation) !== undefined && parentEnvironment[key] !== undefined) values[key] = parentEnvironment[key];
  }

  const withheld: EnvironmentKeyEvidence[] = [];
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (value === undefined || values[key] !== undefined) continue;
    const classification = classify(key, classifiers);
    if (classification !== undefined) withheld.push(evidence(key, classifiers));
  }
  const grantedEvidence = Object.keys(values)
    .filter((key) => classify(key, classifiers) !== undefined)
    .map((key) => evidence(key, classifiers))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    values,
    evidence: {
      baselineKeys: baselineKeys.sort(),
      granted: grantedEvidence,
      withheld: withheld.sort((left, right) => left.key.localeCompare(right.key)),
      valueLogging: "disabled",
    },
  };
}

export function credentialClassifiers(): readonly CredentialClassifier[] {
  return [...DEFAULT_CREDENTIAL_CLASSIFIERS];
}
