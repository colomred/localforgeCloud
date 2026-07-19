import fs from "node:fs";
import path from "node:path";

/**
 * Persistent project memory as plain files inside the project folder:
 *
 *   .localforge/brief.md                — the project brief injected into
 *                                         every session (stack, layout,
 *                                         conventions, what's built)
 *   .localforge/notes/feature-<id>.md   — progress/failure notes so retries
 *                                         resume instead of restarting blind
 *
 * Human-inspectable and editable by design. The ENGINE RUNNER only READS
 * these; all writes go through the orchestrator (single-writer, serialized
 * per project) based on `brief` / `note` events.
 */

export const LOCALFORGE_DIR = ".localforge";

export function briefAbsolutePath(projectDir: string): string {
  return path.join(projectDir, LOCALFORGE_DIR, "brief.md");
}

export function noteRelativePath(featureId: number): string {
  return `${LOCALFORGE_DIR}/notes/feature-${featureId}.md`;
}

export function noteAbsolutePath(projectDir: string, featureId: number): string {
  return path.join(projectDir, LOCALFORGE_DIR, "notes", `feature-${featureId}.md`);
}

const MAX_MEMORY_FILE_BYTES = 64 * 1024;

function readFileIfExists(absPath: string): string | null {
  try {
    const content = fs.readFileSync(absPath, "utf8");
    return content.trim().length > 0
      ? content.slice(0, MAX_MEMORY_FILE_BYTES)
      : null;
  } catch {
    return null;
  }
}

export function readBrief(projectDir: string): string | null {
  return readFileIfExists(briefAbsolutePath(projectDir));
}

export function writeBrief(projectDir: string, content: string): void {
  const abs = briefAbsolutePath(projectDir);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content.slice(0, MAX_MEMORY_FILE_BYTES), "utf8");
}

export function readFeatureNote(
  projectDir: string,
  featureId: number,
): string | null {
  return readFileIfExists(noteAbsolutePath(projectDir, featureId));
}

export function writeFeatureNote(
  projectDir: string,
  featureId: number,
  content: string,
): string {
  const abs = noteAbsolutePath(projectDir, featureId);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content.slice(0, MAX_MEMORY_FILE_BYTES), "utf8");
  return noteRelativePath(featureId);
}

export function clearFeatureNote(projectDir: string, featureId: number): void {
  try {
    fs.unlinkSync(noteAbsolutePath(projectDir, featureId));
  } catch {
    /* nothing to clear */
  }
}
