import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Fail closed: this is an optional read grant, never a reason to broaden the
// workspace or prevent delegation for ordinary (including non-Git) projects.
export function linkedWorktreeCommonDir(rootDir: string): string | undefined {
  try {
    const root = realpathSync(rootDir);
    const pointer = (path: string): string => {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 4096 || realpathSync(path) !== path) throw new Error("Invalid Git pointer");
      const value = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)).replace(/\r?\n$/, "");
      if (!value || /[\x00-\x1f\x7f]/.test(value) || value.trim() !== value) throw new Error("Invalid Git pointer");
      return value;
    };
    const directory = (path: string): string => {
      if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error("Invalid Git directory");
      return path;
    };
    const dotGit = join(root, ".git");
    const entry = pointer(dotGit);
    if (!entry.startsWith("gitdir: ") || entry.length === 8) return undefined;
    const gitDir = directory(resolve(root, entry.slice(8)));
    const commonDir = directory(resolve(gitDir, pointer(join(gitDir, "commondir"))));
    // Require Git's linked-worktree layout, not merely arbitrary mutually
    // referencing files that could grant an unrelated ancestor directory.
    if (dirname(gitDir) !== join(commonDir, "worktrees")) return undefined;
    if (resolve(gitDir, pointer(join(gitDir, "gitdir"))) !== dotGit) return undefined;
    pointer(join(gitDir, "HEAD"));
    pointer(join(commonDir, "HEAD"));
    directory(join(commonDir, "objects"));
    directory(join(commonDir, "refs"));
    return commonDir;
  } catch {
    return undefined;
  }
}
