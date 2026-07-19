import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./verify";

/**
 * Deterministic project scaffolding from bundled templates — zero model
 * turns. The legacy flow burned 30-60 turns on create-next-app + config
 * fixes; now the harness copies a known-good starter with the dev-server
 * port pre-wired and runs npm install itself.
 *
 * Placeholders substituted in every text file: __NAME__, __PORT__.
 */

export type ScaffoldResult = {
  applied: boolean;
  template: string;
  installOk: boolean;
  installOutput: string;
};

const TEXT_EXTENSIONS = new Set([
  ".json", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".md", ".html", ".txt", ".gitignore", "",
]);

function substitute(content: string, vars: Record<string, string>): string {
  let out = content;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`__${key}__`).join(value);
  }
  return out;
}

function copyTemplateDir(
  srcDir: string,
  destDir: string,
  vars: Record<string, string>,
): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    // "gitignore" is stored unprefixed so npm pack / git don't interpret it.
    const destName = entry.name === "gitignore" ? ".gitignore" : entry.name;
    const dest = path.join(destDir, destName);
    if (entry.isDirectory()) {
      copyTemplateDir(src, dest, vars);
    } else {
      const ext = path.extname(entry.name);
      if (TEXT_EXTENSIONS.has(ext)) {
        fs.writeFileSync(dest, substitute(fs.readFileSync(src, "utf8"), vars), "utf8");
      } else {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

export function templateRootDir(harnessRoot?: string): string {
  // The runner passes the harness root from its job file; fall back to
  // resolving relative to this file (lib/engine/ -> repo root).
  const base = harnessRoot ?? path.resolve(__dirname, "..", "..");
  return path.join(base, "templates");
}

export function templateExists(template: string, harnessRoot?: string): boolean {
  if (template === "none") return false;
  try {
    return fs
      .statSync(path.join(templateRootDir(harnessRoot), template))
      .isDirectory();
  } catch {
    return false;
  }
}

/**
 * Apply a template into projectDir (which must not already contain a
 * package.json — callers check) and run npm install.
 */
export async function applyTemplate(opts: {
  projectDir: string;
  template: string;
  projectName: string;
  devServerPort: string;
  harnessRoot?: string;
  installTimeoutMs?: number;
}): Promise<ScaffoldResult> {
  const srcDir = path.join(templateRootDir(opts.harnessRoot), opts.template);
  copyTemplateDir(srcDir, opts.projectDir, {
    NAME: opts.projectName.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase() || "app",
    PORT: opts.devServerPort,
  });

  const install = await runCommand(
    "npm",
    ["install", "--no-audit", "--no-fund"],
    opts.projectDir,
    opts.installTimeoutMs ?? 600_000,
  );
  return {
    applied: true,
    template: opts.template,
    installOk: install.code === 0 && !install.timedOut,
    installOutput: install.output.slice(-2000),
  };
}
