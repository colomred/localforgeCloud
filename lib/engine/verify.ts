import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { clampToolOutput } from "./context";

/**
 * Harness-run verification — the model never certifies its own work and
 * never drives a browser. Deterministic checks with parsed, actionable
 * errors that feed focused fix sessions:
 *
 *   typecheck  npx tsc --noEmit         (when a tsconfig exists)
 *   lint       npm run lint             (when the script exists)
 *   build      npm run build            (when the script exists)
 *   smoke      boot dev server, load the page in chromium, fail on
 *              uncaught page errors; screenshot for the UI
 *   spec       npx playwright test <file>  (Tier 3, non-fatal)
 */

export type ParsedError = {
  file: string;
  line: number | null;
  message: string;
};

export type VerificationOutcome = {
  ok: boolean;
  errorCount: number;
  summary: string;
  errors: ParsedError[];
  output: string;
};

export const MAX_PARSED_ERRORS = 15;

/* ------------------------------ process utils --------------------------- */

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: 5000 });
    } else {
      // Negative pid kills the process group (children spawned with detached).
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
}

export type CommandResult = { code: number | null; output: string; timedOut: boolean };

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    });

    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (output.length < 512 * 1024) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/* ------------------------------ script probes --------------------------- */

export function readPackageJson(
  projectDir: string,
): { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

export function hasScript(projectDir: string, name: string): boolean {
  const pkg = readPackageJson(projectDir);
  return typeof pkg?.scripts?.[name] === "string";
}

export function hasDependency(projectDir: string, name: string): boolean {
  const pkg = readPackageJson(projectDir);
  return Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);
}

/* ------------------------------ tsc parsing ----------------------------- */

/**
 * Parse tsc output. Handles both formats tsc emits:
 *   src/app.ts(12,5): error TS2304: Cannot find name 'x'.
 *   src/app.ts:12:5 - error TS2304: Cannot find name 'x'.
 */
export function parseTscOutput(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const paren = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+:.+)$/;
  const colon = /^(.+?):(\d+):\d+\s+-\s+error\s+(TS\d+:.+)$/;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const m = paren.exec(trimmed) ?? colon.exec(trimmed);
    if (m) {
      errors.push({
        file: m[1].trim(),
        line: Number.parseInt(m[2], 10),
        message: m[3].trim().slice(0, 300),
      });
      if (errors.length >= MAX_PARSED_ERRORS) break;
    }
  }
  return errors;
}

/* ------------------------------ eslint parsing -------------------------- */

/**
 * Parse eslint's default (stylish) formatter: a file path line followed by
 * indented `line:col  error  message  rule` rows.
 */
export function parseEslintOutput(output: string, projectDir: string): ParsedError[] {
  const errors: ParsedError[] = [];
  let currentFile: string | null = null;
  for (const line of output.split("\n")) {
    if (!line.startsWith(" ") && (line.includes("/") || line.includes("\\"))) {
      const candidate = line.trim();
      if (candidate && !candidate.includes(" ")) {
        currentFile = path.isAbsolute(candidate)
          ? path.relative(projectDir, candidate)
          : candidate;
        continue;
      }
    }
    const m = /^\s+(\d+):\d+\s+error\s+(.+)$/.exec(line);
    if (m && currentFile) {
      errors.push({
        file: currentFile,
        line: Number.parseInt(m[1], 10),
        message: m[2].trim().slice(0, 300),
      });
      if (errors.length >= MAX_PARSED_ERRORS) break;
    }
  }
  return errors;
}

/* ------------------------------ verifications --------------------------- */

const TSC_TIMEOUT_MS = 120_000;
const LINT_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 300_000;

export async function runTypecheck(projectDir: string): Promise<VerificationOutcome | null> {
  if (!fs.existsSync(path.join(projectDir, "tsconfig.json"))) return null;
  const result = await runCommand("npx", ["tsc", "--noEmit"], projectDir, TSC_TIMEOUT_MS);
  const errors = parseTscOutput(result.output);
  const ok = result.code === 0 && !result.timedOut;
  return {
    ok,
    errorCount: ok ? 0 : Math.max(errors.length, 1),
    summary: ok
      ? "tsc --noEmit passed"
      : result.timedOut
        ? "tsc --noEmit timed out"
        : `tsc --noEmit: ${errors.length || "?"} error(s)`,
    errors,
    output: clampToolOutput(result.output),
  };
}

export async function runLint(projectDir: string): Promise<VerificationOutcome | null> {
  if (!hasScript(projectDir, "lint")) return null;
  const result = await runCommand("npm", ["run", "lint"], projectDir, LINT_TIMEOUT_MS);
  const errors = parseEslintOutput(result.output, projectDir);
  const ok = result.code === 0 && !result.timedOut;
  return {
    ok,
    errorCount: ok ? 0 : Math.max(errors.length, 1),
    summary: ok ? "lint passed" : `lint: ${errors.length || "?"} error(s)`,
    errors,
    output: clampToolOutput(result.output),
  };
}

export async function runBuild(projectDir: string): Promise<VerificationOutcome | null> {
  if (!hasScript(projectDir, "build")) return null;
  const result = await runCommand("npm", ["run", "build"], projectDir, BUILD_TIMEOUT_MS);
  const ok = result.code === 0 && !result.timedOut;
  // Builds surface tsc-style errors for Next/TS projects; try to parse them
  // so the fix session gets file/line targets instead of a blob.
  const errors = ok ? [] : parseTscOutput(result.output);
  return {
    ok,
    errorCount: ok ? 0 : Math.max(errors.length, 1),
    summary: ok
      ? "build passed"
      : result.timedOut
        ? "build timed out"
        : `build failed (exit ${result.code})`,
    errors,
    output: clampToolOutput(result.output),
  };
}

/* ------------------------------ browser smoke --------------------------- */

export type SmokeOptions = {
  projectDir: string;
  port: string;
  /** Absolute path for the screenshot PNG; parent dir is created. */
  screenshotPath: string | null;
  /** Total budget for boot + load. */
  timeoutMs?: number;
};

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Boot the project's dev server, load it in headless chromium, fail on
 * uncaught page exceptions. Console `.error()` calls are counted in the
 * summary but do NOT fail the smoke — React dev warnings arrive on
 * console.error and would make every project "broken".
 */
export async function runSmoke(opts: SmokeOptions): Promise<VerificationOutcome> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  if (!hasScript(opts.projectDir, "dev")) {
    return {
      ok: true,
      errorCount: 0,
      summary: "smoke skipped (no dev script)",
      errors: [],
      output: "",
    };
  }

  const url = `http://localhost:${opts.port}`;
  const server = spawn("npm", ["run", "dev"], {
    cwd: opts.projectDir,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    env: { ...process.env, NO_COLOR: "1", PORT: opts.port, CI: "1" },
  });
  let serverOutput = "";
  const collect = (chunk: Buffer) => {
    if (serverOutput.length < 64 * 1024) serverOutput += chunk.toString("utf8");
  };
  server.stdout?.on("data", collect);
  server.stderr?.on("data", collect);

  try {
    const up = await waitForServer(url, Math.min(timeoutMs, 60_000));
    if (!up) {
      return {
        ok: false,
        errorCount: 1,
        summary: `smoke failed: dev server did not respond on port ${opts.port}`,
        errors: [],
        output: clampToolOutput(serverOutput),
      };
    }

    let chromium: typeof import("@playwright/test").chromium;
    try {
      ({ chromium } = await import("@playwright/test"));
    } catch {
      // No browser available (e.g. minimal install): HTTP reachability is
      // the best we can do — treat as pass with a note.
      return {
        ok: true,
        errorCount: 0,
        summary: "smoke passed (HTTP only — chromium unavailable)",
        errors: [],
        output: "",
      };
    }

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      let consoleErrorCount = 0;
      page.on("pageerror", (err) => {
        if (pageErrors.length < 10) pageErrors.push(err.message);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrorCount++;
      });

      await page.goto(url, { timeout: 20_000, waitUntil: "load" });
      await page.waitForTimeout(1500);

      const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
      const looksBroken =
        bodyText.trim().length === 0 ||
        /application error|unhandled runtime error/i.test(bodyText);

      if (opts.screenshotPath) {
        fs.mkdirSync(path.dirname(opts.screenshotPath), { recursive: true });
        await page
          .screenshot({ path: opts.screenshotPath, fullPage: false })
          .catch(() => undefined);
      }

      const ok = pageErrors.length === 0 && !looksBroken;
      const consoleNote =
        consoleErrorCount > 0 ? ` (${consoleErrorCount} console.error non-fatal)` : "";
      return {
        ok,
        errorCount: ok ? 0 : Math.max(pageErrors.length, 1),
        summary: ok
          ? `smoke passed: page loaded clean${consoleNote}`
          : pageErrors.length > 0
            ? `smoke failed: uncaught page error: ${pageErrors[0].slice(0, 160)}`
            : "smoke failed: page rendered empty or an error screen",
        errors: pageErrors.map((m) => ({ file: "(browser)", line: null, message: m.slice(0, 300) })),
        output: clampToolOutput(pageErrors.join("\n")),
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } finally {
    killTree(server.pid);
  }
}

/** Tier 3 (opt-in, non-fatal): execute a model-written Playwright spec. */
export async function runSpecFile(
  projectDir: string,
  specRelPath: string,
): Promise<VerificationOutcome> {
  const result = await runCommand(
    "npx",
    ["playwright", "test", specRelPath, "--reporter=line"],
    projectDir,
    180_000,
  );
  const ok = result.code === 0 && !result.timedOut;
  const m = /(\d+)\s+passed/.exec(result.output);
  const f = /(\d+)\s+failed/.exec(result.output);
  const passed = m ? Number.parseInt(m[1], 10) : 0;
  const failed = f ? Number.parseInt(f[1], 10) : ok ? 0 : 1;
  return {
    ok,
    errorCount: failed,
    summary: `spec run: ${passed} passed, ${failed} failed`,
    errors: [],
    output: clampToolOutput(result.output),
  };
}
