import { spawn } from "node:child_process";
import { clampToolOutput } from "../context";
import { stringArg, type EngineTool } from "./types";

/**
 * Whitelisted command execution — NOT a shell. Small models get exactly the
 * commands a feature implementation legitimately needs; everything
 * deterministic (build, lint, dev servers, scaffolding) is run by the
 * harness itself outside the session.
 */

const DEFAULT_TIMEOUT_MS = 180_000;

export type WhitelistedCommand = {
  cmd: string;
  args: string[];
};

/** Parse + validate a command line against the whitelist. Null = rejected. */
export function parseWhitelistedCommand(raw: string): WhitelistedCommand | null {
  const trimmed = raw.trim();
  // Reject shell metacharacters outright — commands run via spawn, no shell.
  if (/[;&|<>`$(){}\\]/.test(trimmed)) return null;

  const parts = trimmed.split(/\s+/);
  const [head, ...rest] = parts;

  const isSafeToken = (t: string) => /^[\w@^~./:-]+$/.test(t) && !t.includes("..");

  if (head === "npm") {
    const [sub, ...npmArgs] = rest;
    if (sub === "run" && npmArgs.length >= 1 && npmArgs.every(isSafeToken)) {
      return { cmd: "npm", args: ["run", ...npmArgs] };
    }
    if (
      (sub === "install" || sub === "i" || sub === "uninstall") &&
      npmArgs.every(isSafeToken)
    ) {
      return { cmd: "npm", args: [sub, ...npmArgs] };
    }
    if (sub === "test" && npmArgs.length === 0) {
      return { cmd: "npm", args: ["test"] };
    }
    return null;
  }

  if (head === "npx") {
    const [pkg, ...npxArgs] = rest;
    if (pkg === "tsc" && npxArgs.every((a) => /^[\w.=/-]+$/.test(a))) {
      return { cmd: "npx", args: ["tsc", ...npxArgs] };
    }
    return null;
  }

  if (head === "node") {
    if (rest.length >= 1 && rest.every(isSafeToken)) {
      return { cmd: "node", args: rest };
    }
    return null;
  }

  return null;
}

export const runScriptTool: EngineTool = {
  name: "run_script",
  description:
    "Run a project command. Allowed: npm run <script>, npm install [pkg], npm test, npx tsc [flags], node <file>. No shell syntax.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "e.g. npm install zod / npx tsc --noEmit / node scripts/seed.js" },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    const raw = stringArg(args, "command");
    if (!raw) return "error: command is required";

    const parsed = parseWhitelistedCommand(raw);
    if (!parsed) {
      return (
        `error: command not allowed: "${raw.slice(0, 120)}". ` +
        `Allowed forms: npm run <script>, npm install [package], npm test, npx tsc [flags], node <file>. No pipes/redirects.`
      );
    }

    return new Promise<string>((resolve) => {
      const child = spawn(parsed.cmd, parsed.args, {
        cwd: ctx.projectDir,
        shell: process.platform === "win32", // npm/npx are .cmd shims on Windows
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
      });

      let output = "";
      const collect = (chunk: Buffer) => {
        if (output.length < 256 * 1024) output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
        output += `\n[timed out after ${DEFAULT_TIMEOUT_MS / 1000}s — long-running processes like dev servers are managed by the harness, do not start them here]`;
      }, DEFAULT_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`error: failed to run ${parsed.cmd}: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const clamped = clampToolOutput(output);
        resolve(`exit code ${code ?? "?"}\n${clamped}`);
      });
    });
  },
};
