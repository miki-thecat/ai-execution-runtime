import { ProjectRegistry } from "./registry.ts";
import { realpathSync } from "node:fs";
import { createRuntimeError, type OperationContext } from "../core/index.ts";
import type { StateStore } from "../state/index.ts";

export function authorityMismatch(message: string): never {
  throw createRuntimeError({ code: "PROJECT_AUTHORITY_MISMATCH", message, retryable: false, effect: "none" });
}

/** Context is supplied by the runtime; IDs are checked against durable bindings. */
export function assertProjectReferences(state: StateStore | undefined, context: Pick<OperationContext, "projectId" | "runId" | "taskId">): void {
  const run = state?.getEntity("runs", context.runId);
  if (run !== undefined && run.projectId !== context.projectId) authorityMismatch("Run belongs to a different project");
  if (context.taskId !== undefined) {
    const task = state?.getEntity("tasks", context.taskId);
    if (task === undefined || task.projectId !== context.projectId || task.runId !== context.runId) authorityMismatch("Task and run bindings do not match the project context");
  }
}

export function assertProjectRoot(state: StateStore | undefined, context: OperationContext, root: string): void {
  assertProjectReferences(state, context);
  if (context.projectId !== undefined) {
    const project = state === undefined ? undefined : new ProjectRegistry({ state }).get(context.projectId);
    if (project === undefined || project.boundary.root.status !== "trusted" || realpathSync(project.rootDir) !== realpathSync(root)) authorityMismatch("File root does not match the registered project");
  }
  if (context.effectPolicy.workspaceRoot !== undefined && realpathSync(context.effectPolicy.workspaceRoot) !== realpathSync(root)) authorityMismatch("File root does not match the runtime workspace");
}
