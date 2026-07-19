import path from "node:path";

/**
 * Workspace containment for tool paths. The system prompt states the rule;
 * this is the enforcement layer (including MSYS path normalization so
 * Git-Bash style /c/Users/... paths resolve correctly on Windows).
 */

const isWindows = process.platform === "win32";

function normaliseMsysPath(p: string): string {
  if (!isWindows) return p;
  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (msys) {
    return `${msys[1].toUpperCase()}:${(msys[2] ?? "\\").replace(/\//g, "\\")}`;
  }
  return p;
}

export class WorkspaceViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceViolationError";
  }
}

/**
 * Resolve `candidate` against the workspace root and throw when it escapes.
 * Returns the absolute, normalized path when inside.
 */
export function resolveInsideWorkspace(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normaliseMsysPath(candidate));
  if (resolved === resolvedRoot) return resolved;
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceViolationError(
      `path ${candidate} resolves outside the workspace. Use a path inside the project directory.`,
    );
  }
  return resolved;
}
