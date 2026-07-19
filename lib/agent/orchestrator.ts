import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/* ──────────────────── Debug file logger ──────────────────── */
const DEBUG_LOG_PATH = path.join(process.cwd(), "forge-debug.log");

function debugLog(label: string, data?: unknown): void {
  try {
    const ts = new Date().toISOString();
    let line = `[${ts}] [orchestrator] [${label}]`;
    if (data !== undefined) {
      const serialized =
        typeof data === "string"
          ? data
          : JSON.stringify(data, null, 2);
      line += ` ${serialized}`;
    }
    fs.appendFileSync(DEBUG_LOG_PATH, line + "\n", "utf8");
  } catch {
    // Never let debug logging break the orchestrator
  }
}

import {
  closeAgentSession,
  createAgentSession,
  getActiveSessionsForProject,
  type AgentSessionRecord,
  type SessionStatus,
} from "../agent-sessions";
import {
  appendAgentLog,
  type AgentMessageType,
} from "./logs";
import {
  findNextReadyFeatureForProject,
  getInProgressFeaturesForProject,
  demoteFeatureToBacklog,
  getFeature,
  updateFeature,
  type FeatureRecord,
} from "../features";
import {
  getProject,
  markProjectCompletedIfAllDone,
} from "../projects";
import {
  getEffectiveProviderConfig,
  getProjectEffectiveSettings,
  MAX_CONCURRENT_AGENTS_HARD_CAP,
  parseContextWindow,
} from "../settings";
import {
  parseRunnerLine,
  type RunnerBudgetEvent,
  type RunnerEvent,
  type RunnerPhaseEvent,
  type RunnerPlanEvent,
  type RunnerStepEvent,
  type RunnerVerificationEvent,
} from "../engine/events";
import {
  resetStepsForRetry,
  updateStepStatus,
  replaceStepsForFeature,
  isFeatureStepStatus,
} from "../feature-steps";
import {
  incrementFeatureAttemptCount,
  setFeatureNotePath,
} from "../features";
import {
  clearFeatureNote,
  noteRelativePath,
  writeBrief,
  writeFeatureNote,
} from "../engine/memory";
import type { PipelineJob } from "../engine/pipeline";

/**
 * Coding-agent orchestrator.
 *
 * Responsibilities:
 *   1. Pick the highest-priority ready backlog feature for a project and
 *      transition it to `in_progress`.
 *   2. Spawn the forge engine runner (scripts/engine-runner.ts) as a child
 *      process with a self-contained job file (provider config, steps to
 *      resume, memory paths).
 *   3. Parse the runner's JSON-lines RunnerEvents: persist steps + logs
 *      (structured events into agent_logs.meta), write brief/note files,
 *      and broadcast everything to live SSE subscribers.
 *   4. When the runner exits, transition the feature to `completed` on
 *      success or demote it back to the backlog with a lowered priority on
 *      failure. Close the agent_session row in either case.
 *
 * The active set of sessions lives in an in-process map. Persistence of
 * *results* (session rows, logs, feature status) is all in SQLite so nothing
 * is lost if the dev server restarts mid-run; the child process is
 * orphaned/reaped but the UI picks up the stored state on reload.
 *
 * This module is intentionally *not* a React/Next concern — it's a plain
 * Node.js module with an EventEmitter so API routes, SSE endpoints, and unit
 * tests can all share the same instance.
 */

export type OrchestratorLogEvent = {
  type: "log";
  sessionId: number;
  featureId: number | null;
  message: string;
  messageType: AgentMessageType;
  screenshotPath?: string | null;
  createdAt: string;
  logId: number;
};

export type OrchestratorStatusEvent = {
  type: "status";
  sessionId: number;
  featureId: number | null;
  sessionStatus: SessionStatus;
  featureName?: string;
  featureStatus?: FeatureRecord["status"];
};

/**
 * Emitted once when every feature in a project reaches the `completed` state
 * and the project row's status is flipped to `completed` (Feature #101). The
 * celebration screen subscribes to this so it can fire confetti without
 * polling.
 *
 * Note: sessionId is set to the final winning coding session so that listeners
 * using the generic `subscribeToAll` shape still have a defined field, but
 * consumers typically only key off `projectId`.
 */
export type OrchestratorProjectCompletedEvent = {
  type: "project_completed";
  sessionId: number;
  projectId: number;
};

/**
 * Structured pipeline events from the forge engine runner, re-broadcast to
 * SSE subscribers enriched with the session id. The UI renders step
 * checklists, phase labels, verification chips and context meters from
 * these; `plan`/`step` are also persisted to `feature_steps` and
 * `phase`/`verification`/`budget(handoff)` to `agent_logs.meta` so
 * reconnecting clients can replay the pipeline state.
 */
export type OrchestratorPipelineEvent = { sessionId: number } & (
  | RunnerPlanEvent
  | RunnerStepEvent
  | RunnerPhaseEvent
  | RunnerVerificationEvent
  | RunnerBudgetEvent
);

/** The project brief file changed; open brief viewers refetch on this. */
export type OrchestratorBriefUpdatedEvent = {
  type: "brief_updated";
  sessionId: number;
  projectId: number;
};

export type OrchestratorEvent =
  | OrchestratorLogEvent
  | OrchestratorStatusEvent
  | OrchestratorProjectCompletedEvent
  | OrchestratorPipelineEvent
  | OrchestratorBriefUpdatedEvent;

type RunningSession = {
  session: AgentSessionRecord;
  feature: FeatureRecord;
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrBuffer: string;
  /**
   * Absolute path to the JSON job file written for this run. The runner
   * reads it on startup; the orchestrator cleans it up on close.
   */
  promptFile: string;
  /** Project folder — target for brief/note writes from runner events. */
  projectDir: string;
  /** Absolute watchdog — kills the runner past the hard session deadline. */
  watchdog?: ReturnType<typeof setTimeout>;
  /** Inactivity watchdog (forge engine): no stdout for too long ⇒ kill. */
  idleTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Structural upper bound on concurrent coding agent sessions per project.
 * The effective per-project limit is resolved from settings via
 * {@link getMaxConcurrentAgentsForProject} and clamped to this cap.
 */
export const MAX_CONCURRENT_AGENTS_CAP = MAX_CONCURRENT_AGENTS_HARD_CAP;

/**
 * Resolve the effective concurrent-agent limit for a project by reading the
 * `max_concurrent_agents` setting (project override falls back to global,
 * default "3"). The value is clamped into [1, {@link MAX_CONCURRENT_AGENTS_CAP}]
 * so a bad config can't spawn an unbounded number of agents.
 */
export function getMaxConcurrentAgentsForProject(projectId: number): number {
  const eff = getProjectEffectiveSettings(projectId);
  const n = Number.parseInt(eff.max_concurrent_agents, 10);
  if (!Number.isFinite(n)) return MAX_CONCURRENT_AGENTS_CAP;
  return Math.max(1, Math.min(MAX_CONCURRENT_AGENTS_CAP, n));
}

/**
 * Watchdogs. The pipeline emits events constantly (every tool call, phase
 * change, verification), so silence is the real hang signal — the absolute
 * cap is only a backstop for pathological runs.
 */
const FORGE_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.LOCALFORGE_IDLE_TIMEOUT_MS ?? String(10 * 60 * 1000),
  10,
);
const FORGE_SESSION_TIMEOUT_MS = Number.parseInt(
  process.env.LOCALFORGE_SESSION_TIMEOUT_MS ?? String(90 * 60 * 1000),
  10,
);

type OrchestratorState = {
  running: Map<number, RunningSession>; // keyed by session id
  events: EventEmitter;
};

// Hot-reload safe singleton. Next.js dev mode will clear this module's
// exports whenever the file changes, but child processes + subscribers are
// expensive to lose, so we stash the state on globalThis.
const GLOBAL_KEY = Symbol.for("localforge.orchestrator.state");
type GlobalStash = { [GLOBAL_KEY]?: OrchestratorState };
const g = globalThis as unknown as GlobalStash;

function getState(): OrchestratorState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      running: new Map(),
      events: new EventEmitter(),
    };
    // EventEmitter defaults to 10 listeners; SSE connections can stack up
    // during development hot reloads so raise the cap.
    g[GLOBAL_KEY].events.setMaxListeners(50);
  }
  return g[GLOBAL_KEY];
}

function broadcast(event: OrchestratorEvent): void {
  getState().events.emit("event", event);
  getState().events.emit(`session:${event.sessionId}`, event);
  if (event.type === "project_completed") {
    getState().events.emit(`project:${event.projectId}`, event);
  }
}

/**
 * Subscribe to project-scoped events (currently just project_completed). The
 * celebration screen uses this to fire confetti without polling.
 */
export function subscribeToProject(
  projectId: number,
  listener: (ev: OrchestratorEvent) => void,
): () => void {
  const key = `project:${projectId}`;
  getState().events.on(key, listener);
  return () => {
    getState().events.off(key, listener);
  };
}

/**
 * Subscribe to events emitted by the orchestrator for a given session. The
 * returned function removes the listener. Callers should call it on
 * disconnect to avoid leaking listeners.
 */
export function subscribeToSession(
  sessionId: number,
  listener: (ev: OrchestratorEvent) => void,
): () => void {
  const key = `session:${sessionId}`;
  getState().events.on(key, listener);
  return () => {
    getState().events.off(key, listener);
  };
}

/**
 * Subscribe to ALL orchestrator events (any session). Used by the toast
 * notifier so a single subscription picks up completion events for every
 * running session, including ones that are started after the client connects.
 */
export function subscribeToAll(
  listener: (ev: OrchestratorEvent) => void,
): () => void {
  getState().events.on("event", listener);
  return () => {
    getState().events.off("event", listener);
  };
}

export function isSessionRunning(sessionId: number): boolean {
  return getState().running.has(sessionId);
}

export function getRunningSessionsForProject(
  projectId: number,
): AgentSessionRecord[] {
  const out: AgentSessionRecord[] = [];
  for (const rs of getState().running.values()) {
    if (rs.session.projectId === projectId) out.push(rs.session);
  }
  return out;
}

export type StartResult = {
  session: AgentSessionRecord;
  feature: FeatureRecord;
  started: boolean;
};

export type AgentSlot = {
  slotIndex: number; // 0, 1, 2
  running: boolean;
  sessionId?: number;
  featureId?: number;
  featureTitle?: string;
};

/**
 * Start the orchestrator for a project. Picks the highest-priority ready
 * feature, creates the agent_session row, spawns the runner child process,
 * and returns the session + feature.
 *
 * Supports up to MAX_CONCURRENT_AGENTS_CAP concurrent coding sessions per
 * project. If the limit is already reached, throws a 409 error.
 *
 * Throws when:
 *   - the project does not exist
 *   - max concurrent agents reached
 *   - there is no ready feature to work on
 */
export function startOrchestrator(projectId: number): StartResult {
  const project = getProject(projectId);
  if (!project) {
    throw new OrchestratorError("Project not found", 404);
  }

  // Reconcile ALL orphaned DB session rows whose child processes have died.
  // This keeps the DB from getting wedged if the dev server crashed mid-run.
  const existingSessions = getActiveSessionsForProject(projectId, "coding");
  for (const existing of existingSessions) {
    if (!getState().running.has(existing.id)) {
      // Reap: close the orphaned row so it doesn't count against the limit.
      closeAgentSession(existing.id, "terminated");
    }
  }

  // Recover orphaned features stuck in "in_progress" with no running session.
  // This happens when the dev server restarts mid-run: the session gets reaped
  // above but the feature stays wedged. Reset them to backlog so they can be
  // picked up again.
  const runningFeatureIds = new Set(
    [...getState().running.values()]
      .filter((rs) => rs.session.projectId === projectId)
      .map((rs) => rs.feature.id),
  );
  const orphanedFeatures = getInProgressFeaturesForProject(projectId).filter(
    (f) => !runningFeatureIds.has(f.id),
  );
  for (const orphan of orphanedFeatures) {
    debugLog("RECOVER_ORPHANED_FEATURE", {
      featureId: orphan.id,
      title: orphan.title,
    });
    updateFeature(orphan.id, { status: "backlog" });
  }

  // Check how many sessions are currently running for this project.
  const runningSessions = getRunningSessionsForProject(projectId);
  const runningCount = runningSessions.length;
  const limit = getMaxConcurrentAgentsForProject(projectId);
  if (runningCount >= limit) {
    throw new OrchestratorError(
      `Maximum concurrent agents reached (${runningCount}/${limit})`,
      409,
    );
  }

  const feature = findNextReadyFeatureForProject(projectId);
  if (!feature) {
    throw new OrchestratorError(
      "No ready features to work on (backlog empty or all blocked)",
      409,
    );
  }

  // Flip the feature to in_progress before creating the session so the UI
  // sees a consistent state if it reloads between these two writes.
  const movedFeature = updateFeature(feature.id, { status: "in_progress" });
  if (!movedFeature) {
    throw new OrchestratorError("Failed to transition feature status", 500);
  }

  const session = createAgentSession({
    projectId,
    sessionType: "coding",
    featureId: movedFeature.id,
  });

  // Persist + broadcast a startup log so the UI has something to render
  // immediately (the runner's first line lands ~50ms later).
  const startLog = appendAgentLog({
    sessionId: session.id,
    featureId: movedFeature.id,
    message: `Orchestrator starting coding agent for "${movedFeature.title}"`,
    messageType: "info",
  });
  broadcast({
    type: "log",
    sessionId: session.id,
    featureId: movedFeature.id,
    message: startLog.message,
    messageType: startLog.messageType as AgentMessageType,
    screenshotPath: startLog.screenshotPath,
    createdAt: startLog.createdAt,
    logId: startLog.id,
  });
  broadcast({
    type: "status",
    sessionId: session.id,
    featureId: movedFeature.id,
    sessionStatus: "in_progress",
    featureName: movedFeature.title,
    featureStatus: "in_progress",
  });

  const { child, promptFile } = spawnEngineRunner({
    session,
    feature: movedFeature,
    project,
  });

  const rs: RunningSession = {
    session,
    feature: movedFeature,
    child,
    stdoutBuffer: "",
    stderrBuffer: "",
    promptFile,
    projectDir: project.folderPath,
  };
  getState().running.set(session.id, rs);

  attachChildHandlers(rs);

  // Absolute watchdog: kill the runner past the hard session deadline.
  // Silence, not duration, is the real hang signal (see the idle watchdog),
  // so the cap is generous.
  if (FORGE_SESSION_TIMEOUT_MS > 0) {
    rs.watchdog = setTimeout(() => {
      killForWatchdog(
        rs,
        `Session watchdog: runner exceeded ${Math.round(FORGE_SESSION_TIMEOUT_MS / 1000 / 60)}min timeout — killing`,
      );
    }, FORGE_SESSION_TIMEOUT_MS);
    rs.watchdog.unref();
  }
  if (FORGE_IDLE_TIMEOUT_MS > 0) {
    armIdleWatchdog(rs);
  }

  return { session, feature: movedFeature, started: true };
}

/**
 * Force-stop a running orchestrator session. Terminates the child process
 * and marks the session as terminated. The feature is moved back to the
 * backlog if it was still in_progress.
 */
export function stopOrchestratorSession(sessionId: number): {
  stopped: boolean;
  session: AgentSessionRecord | null;
} {
  const rs = getState().running.get(sessionId);
  if (!rs) {
    // The session may already have finished, or this is an orphan row from
    // a dev-server crash. Either way, close the DB row as terminated so the
    // UI can render a consistent state. closeAgentSession is a no-op if the
    // row already has a terminal status.
    const closed = closeAgentSession(sessionId, "terminated");
    return { stopped: false, session: closed };
  }

  // Signal the child first so its SIGTERM handler can emit a final log
  // line. Fall back to SIGKILL after 500ms if it's still alive.
  try {
    rs.child.kill("SIGTERM");
  } catch {
    // best-effort
  }
  const killTimer = setTimeout(() => {
    try {
      if (!rs.child.killed) rs.child.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }, 500);
  killTimer.unref();

  // The 'close' handler will finish the cleanup: feature → backlog,
  // session → terminated, running map entry removed. Return the current
  // session row here so the HTTP caller has something to report.
  return { stopped: true, session: rs.session };
}

/** Internal error class so API routes can translate to the right status code. */
export class OrchestratorError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
    this.name = "OrchestratorError";
  }
}

/** Kill a runner because a watchdog fired; logs + lets close() finalize. */
function killForWatchdog(rs: RunningSession, message: string): void {
  if (!getState().running.has(rs.session.id)) return;
  const log = appendAgentLog({
    sessionId: rs.session.id,
    featureId: rs.feature.id,
    message,
    messageType: "error",
  });
  broadcast({
    type: "log",
    sessionId: rs.session.id,
    featureId: rs.feature.id,
    message: log.message,
    messageType: "error",
    screenshotPath: log.screenshotPath,
    createdAt: log.createdAt,
    logId: log.id,
  });
  try {
    rs.child.kill("SIGTERM");
  } catch {
    /* best-effort */
  }
  setTimeout(() => {
    try {
      if (!rs.child.killed) rs.child.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }, 1000).unref();
}

/** (Re)arm the forge idle watchdog; called on every stdout line. */
function armIdleWatchdog(rs: RunningSession): void {
  if (rs.idleTimer) clearTimeout(rs.idleTimer);
  rs.idleTimer = setTimeout(() => {
    killForWatchdog(
      rs,
      `Idle watchdog: no runner output for ${Math.round(FORGE_IDLE_TIMEOUT_MS / 1000 / 60)}min — killing`,
    );
  }, FORGE_IDLE_TIMEOUT_MS);
  rs.idleTimer.unref();
}

/* --------------------------- Child process ---------------------------- */

/**
 * Spawn the forge engine runner (scripts/engine-runner.ts) for a feature.
 * The child is TypeScript executed via tsx; it is spawned from the harness
 * root so `--import tsx` resolves from the harness's node_modules, and it
 * receives everything it needs in a single job file — no DB, no settings.
 */
function spawnEngineRunner(args: {
  session: AgentSessionRecord;
  feature: FeatureRecord;
  project: { id: number; name: string; folderPath: string };
}): { child: ChildProcessWithoutNullStreams; promptFile: string } {
  const harnessRoot = process.cwd();
  const runnerPath = path.join(harnessRoot, "scripts", "engine-runner.ts");
  const { baseUrl, model, provider } = getEffectiveProviderConfig(
    args.session.projectId,
  );
  const eff = getProjectEffectiveSettings(args.session.projectId);

  // Prepare steps for a potential resume: passed steps survive, everything
  // else resets to planned. A feature on its first attempt has no rows and
  // the pipeline will run its PLAN pass.
  const stepRows = resetStepsForRetry(args.feature.id);

  const slug =
    args.feature.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "feature";
  const screenshotRelPath = `screenshots/feature-${args.feature.id}-${slug}.png`;
  const screenshotPath = path.join(harnessRoot, screenshotRelPath);

  const job: PipelineJob = {
    sessionId: args.session.id,
    feature: {
      id: args.feature.id,
      title: args.feature.title,
      description: args.feature.description,
      acceptanceCriteria: args.feature.acceptanceCriteria,
    },
    projectDir: args.project.folderPath,
    projectName: args.project.name,
    provider: provider === "ollama" ? "ollama" : "lm_studio",
    baseUrl,
    model,
    devServerPort: eff.dev_server_port || "3000",
    template: eff.project_template || "next-app",
    coderPrompt: eff.coder_prompt || "",
    contextWindowFallback: parseContextWindow(eff.context_window),
    specGeneration: eff.spec_generation === "true",
    harnessRoot,
    screenshotPath,
    screenshotRelPath,
    existingSteps: stepRows.map((row) => ({
      index: row.stepIndex,
      title: row.title,
      detail: row.detail ?? "",
      status: row.status,
    })),
  };

  const promptFile = path.join(
    os.tmpdir(),
    `localforge-job-${args.session.id}.json`,
  );
  fs.writeFileSync(promptFile, JSON.stringify(job, null, 2), "utf8");

  debugLog("═══════════════════ NEW FORGE SESSION ═══════════════════");
  debugLog("SPAWN_ENGINE_RUNNER", {
    sessionId: args.session.id,
    featureId: args.feature.id,
    featureTitle: args.feature.title,
    projectDir: args.project.folderPath,
    baseUrl,
    model,
    provider,
    existingSteps: job.existingSteps.length,
    contextWindowFallback: job.contextWindowFallback,
  });

  const child = spawn(
    process.execPath,
    ["--import", "tsx", runnerPath, "--job-file", promptFile],
    {
      cwd: harnessRoot,
      env: { ...process.env },
      stdio: "pipe",
    },
  ) as ChildProcessWithoutNullStreams;

  debugLog("SPAWN_ENGINE_RUNNER_PID", {
    pid: child.pid,
    sessionId: args.session.id,
  });
  return { child, promptFile };
}

function attachChildHandlers(rs: RunningSession): void {
  const { child, session, feature } = rs;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    rs.stdoutBuffer += chunk;
    let nl = rs.stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = rs.stdoutBuffer.slice(0, nl).trim();
      rs.stdoutBuffer = rs.stdoutBuffer.slice(nl + 1);
      if (line.length > 0) handleRunnerLine(rs, line);
      nl = rs.stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk: string) => {
    rs.stderrBuffer += chunk;
    // Don't try to parse JSON from stderr — just buffer it for the close
    // handler in case of a crash diagnostic. A non-empty stderr by itself
    // isn't a failure signal.
  });

  child.on("error", (err) => {
    debugLog("CHILD_ERROR", { sessionId: session.id, featureId: feature.id, error: err.message });
    const log = appendAgentLog({
      sessionId: session.id,
      featureId: feature.id,
      message: `Failed to spawn agent runner: ${err.message}`,
      messageType: "error",
    });
    broadcast({
      type: "log",
      sessionId: session.id,
      featureId: feature.id,
      message: log.message,
      messageType: "error",
      screenshotPath: log.screenshotPath,
      createdAt: log.createdAt,
      logId: log.id,
    });
    finalizeSession(rs, "failed");
  });

  child.on("close", (code, signal) => {
    const stillRunning = getState().running.has(session.id);
    debugLog("CHILD_CLOSE", {
      sessionId: session.id,
      featureId: feature.id,
      exitCode: code,
      signal,
      stillInRunningMap: stillRunning,
      stderrLength: rs.stderrBuffer.length,
      remainingStdout: rs.stdoutBuffer.trim().length,
    });

    if (rs.stderrBuffer.trim().length > 0) {
      debugLog("CHILD_STDERR", rs.stderrBuffer.trim().slice(0, 2000));
    }

    // Flush any unterminated line still in the stdout buffer.
    if (rs.stdoutBuffer.trim().length > 0) {
      debugLog("CHILD_CLOSE_FLUSHING_STDOUT", rs.stdoutBuffer.trim().slice(0, 500));
      handleRunnerLine(rs, rs.stdoutBuffer.trim());
      rs.stdoutBuffer = "";
    }

    // Decide outcome: the runner's "done" event sets this via
    // finalizeSession() already; if not, infer from exit code.
    if (getState().running.has(session.id)) {
      if (code === 0) {
        debugLog("CHILD_CLOSE_INFERRED_SUCCESS", { sessionId: session.id });
        finalizeSession(rs, "success");
      } else {
        const reason =
          signal != null
            ? `terminated by ${signal}`
            : `runner exited with code ${code ?? "unknown"}`;
        debugLog("CHILD_CLOSE_INFERRED_FAILURE", { sessionId: session.id, reason });
        const log = appendAgentLog({
          sessionId: session.id,
          featureId: feature.id,
          message: reason,
          messageType: "error",
        });
        broadcast({
          type: "log",
          sessionId: session.id,
          featureId: feature.id,
          message: log.message,
          messageType: "error",
          screenshotPath: log.screenshotPath,
          createdAt: log.createdAt,
          logId: log.id,
        });
        finalizeSession(
          rs,
          signal === "SIGTERM" || signal === "SIGKILL" ? "terminated" : "failed",
        );
      }
    } else {
      debugLog("CHILD_CLOSE_ALREADY_FINALIZED", { sessionId: session.id });
    }
  });
}

/** Persist a log row (optionally with structured meta) and broadcast it. */
function persistLog(
  rs: RunningSession,
  message: string,
  messageType: AgentMessageType,
  screenshotPath: string | null = null,
  meta: string | null = null,
): void {
  const log = appendAgentLog({
    sessionId: rs.session.id,
    featureId: rs.feature.id,
    message,
    messageType,
    screenshotPath,
    meta,
  });
  broadcast({
    type: "log",
    sessionId: rs.session.id,
    featureId: rs.feature.id,
    message: log.message,
    messageType,
    screenshotPath: log.screenshotPath,
    createdAt: log.createdAt,
    logId: log.id,
  });
}

function handleRunnerLine(rs: RunningSession, raw: string): void {
  armIdleWatchdog(rs);

  const event: RunnerEvent | null = parseRunnerLine(raw);
  if (!event) {
    // Not a protocol line (stray console noise) — keep it as a raw info log.
    persistLog(rs, raw, "info");
    return;
  }

  switch (event.type) {
    case "log":
      persistLog(
        rs,
        event.message,
        normaliseMessageType(event.messageType),
        event.screenshotPath ?? null,
      );
      return;

    case "done":
      debugLog("RUNNER_DONE_EVENT", {
        sessionId: rs.session.id,
        featureId: rs.feature.id,
        outcome: event.outcome,
        reason: event.reason,
        failedStepIndex: event.failedStepIndex,
      });
      finalizeSession(rs, event.outcome === "success" ? "success" : "failed");
      return;

    case "plan":
      replaceStepsForFeature(
        rs.feature.id,
        event.steps.map((s) => ({
          stepIndex: s.index,
          title: s.title,
          detail: s.detail,
        })),
      );
      broadcast({ ...event, sessionId: rs.session.id });
      return;

    case "step":
      if (isFeatureStepStatus(event.status)) {
        updateStepStatus(rs.feature.id, event.stepIndex, {
          status: event.status,
          error: event.error ?? null,
          attempt: event.attempt,
        });
      }
      broadcast({ ...event, sessionId: rs.session.id });
      return;

    case "phase": {
      const stepPart =
        event.stepIndex != null
          ? ` (step ${event.stepIndex + 1}${event.stepCount ? `/${event.stepCount}` : ""})`
          : "";
      persistLog(
        rs,
        `Phase: ${event.phase}${stepPart}`,
        "info",
        null,
        JSON.stringify(event),
      );
      broadcast({ ...event, sessionId: rs.session.id });
      return;
    }

    case "verification":
      persistLog(rs, event.summary, "test_result", null, JSON.stringify(event));
      broadcast({ ...event, sessionId: rs.session.id });
      return;

    case "budget":
      // Snapshots are frequent; only handoffs are worth a durable log row.
      if (event.handoff) {
        persistLog(
          rs,
          `Context handoff at ${event.usedTokens}/${event.limitTokens} tokens — respawning session`,
          "info",
          null,
          JSON.stringify(event),
        );
      }
      broadcast({ ...event, sessionId: rs.session.id });
      return;

    case "brief":
      try {
        writeBrief(rs.projectDir, event.content);
        broadcast({
          type: "brief_updated",
          sessionId: rs.session.id,
          projectId: rs.session.projectId,
        });
      } catch (err) {
        debugLog("BRIEF_WRITE_FAILED", {
          sessionId: rs.session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;

    case "note":
      try {
        writeFeatureNote(rs.projectDir, event.featureId, event.content);
        setFeatureNotePath(event.featureId, noteRelativePath(event.featureId));
      } catch (err) {
        debugLog("NOTE_WRITE_FAILED", {
          sessionId: rs.session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
  }
}

function normaliseMessageType(raw: unknown): AgentMessageType {
  const valid: AgentMessageType[] = [
    "info",
    "action",
    "error",
    "screenshot",
    "test_result",
  ];
  if (typeof raw === "string" && valid.includes(raw as AgentMessageType)) {
    return raw as AgentMessageType;
  }
  return "info";
}

function finalizeSession(
  rs: RunningSession,
  outcome: "success" | "failed" | "terminated",
): void {
  debugLog("FINALIZE_SESSION_CALLED", {
    sessionId: rs.session.id,
    featureId: rs.feature.id,
    featureTitle: rs.feature.title,
    outcome,
    inRunningMap: getState().running.has(rs.session.id),
  });

  // Idempotent — only run once per session.
  if (!getState().running.has(rs.session.id)) {
    debugLog("FINALIZE_SESSION_SKIPPED_ALREADY_FINALIZED", { sessionId: rs.session.id });
    return;
  }
  getState().running.delete(rs.session.id);

  if (rs.watchdog) {
    clearTimeout(rs.watchdog);
    rs.watchdog = undefined;
    debugLog("WATCHDOG_CLEARED", { sessionId: rs.session.id });
  }
  if (rs.idleTimer) {
    clearTimeout(rs.idleTimer);
    rs.idleTimer = undefined;
  }

  // Best-effort cleanup of the temp prompt file the runner consumed.
  try {
    if (rs.promptFile) fs.unlinkSync(rs.promptFile);
  } catch {
    /* ignore */
  }

  let finalSessionStatus: SessionStatus;
  let finalFeature: FeatureRecord | null = getFeature(rs.feature.id);

  if (outcome === "success") {
    finalSessionStatus = "completed";
    finalFeature = updateFeature(rs.feature.id, { status: "completed" });
    // The feature is done — its progress/failure note has served its purpose.
    try {
      clearFeatureNote(rs.projectDir, rs.feature.id);
      setFeatureNotePath(rs.feature.id, null);
    } catch {
      /* best-effort */
    }
    const log = appendAgentLog({
      sessionId: rs.session.id,
      featureId: rs.feature.id,
      message: `Feature "${rs.feature.title}" marked completed`,
      messageType: "info",
    });
    broadcast({
      type: "log",
      sessionId: rs.session.id,
      featureId: rs.feature.id,
      message: log.message,
      messageType: "info",
      screenshotPath: log.screenshotPath,
      createdAt: log.createdAt,
      logId: log.id,
    });
  } else if (outcome === "failed") {
    finalSessionStatus = "failed";
    incrementFeatureAttemptCount(rs.feature.id);
    const demoted = demoteFeatureToBacklog(rs.feature.id);
    finalFeature = demoted;
    const log = appendAgentLog({
      sessionId: rs.session.id,
      featureId: rs.feature.id,
      message: demoted
        ? `Feature "${rs.feature.title}" demoted back to backlog (priority ${demoted.priority})`
        : `Feature "${rs.feature.title}" returned to backlog`,
      messageType: "error",
    });
    broadcast({
      type: "log",
      sessionId: rs.session.id,
      featureId: rs.feature.id,
      message: log.message,
      messageType: "error",
      screenshotPath: log.screenshotPath,
      createdAt: log.createdAt,
      logId: log.id,
    });
  } else {
    // terminated — move feature back to backlog (no priority demotion since
    // the user explicitly stopped).
    finalSessionStatus = "terminated";
    finalFeature =
      updateFeature(rs.feature.id, { status: "backlog" }) ?? finalFeature;
    const log = appendAgentLog({
      sessionId: rs.session.id,
      featureId: rs.feature.id,
      message: `Session stopped — feature "${rs.feature.title}" returned to backlog`,
      messageType: "info",
    });
    broadcast({
      type: "log",
      sessionId: rs.session.id,
      featureId: rs.feature.id,
      message: log.message,
      messageType: "info",
      screenshotPath: log.screenshotPath,
      createdAt: log.createdAt,
      logId: log.id,
    });
  }

  closeAgentSession(rs.session.id, finalSessionStatus);

  broadcast({
    type: "status",
    sessionId: rs.session.id,
    featureId: rs.feature.id,
    sessionStatus: finalSessionStatus,
    featureName: rs.feature.title,
    featureStatus: finalFeature?.status,
  });

  // Feature #101 — celebration screen hook. Whenever a feature transitions
  // to "completed" we check whether the project as a whole is now done and,
  // if so, flip its status + broadcast a one-shot event so the UI can react.
  // The helper is idempotent so it is safe to call from every successful
  // finalize (it returns null when nothing changed).
  //
  // Feature #70 — auto-continue loop. If the project is NOT fully done but
  // has another ready feature in the backlog, spawn the next coding session
  // automatically so the user doesn't have to click Start between features.
  debugLog("FINALIZE_SESSION_COMPLETE", {
    sessionId: rs.session.id,
    outcome,
    finalSessionStatus,
    finalFeatureStatus: finalFeature?.status,
  });

  if (outcome === "success") {
    let projectIsDone = false;
    try {
      const completedProject = markProjectCompletedIfAllDone(
        rs.session.projectId,
      );
      if (completedProject) {
        projectIsDone = true;
        debugLog("PROJECT_COMPLETED", { projectId: completedProject.id });
        broadcast({
          type: "project_completed",
          sessionId: rs.session.id,
          projectId: completedProject.id,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[localforge] project completion check failed:", err);
    }

    if (!projectIsDone) {
      debugLog("AUTO_CONTINUE_AFTER_SUCCESS", { sessionId: rs.session.id });
      maybeContinueWithNextFeature(rs);
    }
  } else if (outcome === "failed") {
    debugLog("AUTO_CONTINUE_AFTER_FAILURE", { sessionId: rs.session.id });
    maybeContinueWithNextFeature(rs);
  } else {
    debugLog("NO_AUTO_CONTINUE_TERMINATED", { sessionId: rs.session.id });
  }
}

/**
 * Feature #70 — "orchestrator continues to next feature after completion".
 *
 * After a successful finalize we check whether there are open agent slots
 * and ready features, and fill those slots. Wrapped in `setImmediate` so we
 * unwind the current call stack (releasing the `getState().running` slot we
 * just deleted) before the new `startOrchestrator` runs.
 *
 * Errors are swallowed + logged — any failure leaves the kanban in its
 * current state and the user can click Start again manually.
 */
function maybeContinueWithNextFeature(rs: RunningSession): void {
  const projectId = rs.session.projectId;
  debugLog("MAYBE_CONTINUE_SCHEDULED", { projectId, previousSessionId: rs.session.id });

  setImmediate(() => {
    try {
      // Fill all available slots, not just one.
      const runningCount = getRunningSessionsForProject(projectId).length;
      const slotsAvailable =
        getMaxConcurrentAgentsForProject(projectId) - runningCount;
      debugLog("MAYBE_CONTINUE_SLOTS", {
        projectId,
        runningCount,
        slotsAvailable,
      });

      for (let i = 0; i < slotsAvailable; i++) {
        const next = findNextReadyFeatureForProject(projectId);
        if (!next) {
          debugLog("MAYBE_CONTINUE_NO_MORE_FEATURES", { projectId, filledSlots: i });
          break;
        }
        try {
          startOrchestrator(projectId);
          debugLog("MAYBE_CONTINUE_STARTED", { projectId, nextFeatureId: next.id, slotFill: i + 1 });
        } catch (err) {
          debugLog("MAYBE_CONTINUE_SLOT_ERROR", {
            projectId,
            slotFill: i + 1,
            error: err instanceof Error ? err.message : String(err),
          });
          break; // Stop trying to fill more slots if one fails
        }
      }
    } catch (err) {
      debugLog("MAYBE_CONTINUE_ERROR", {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      // eslint-disable-next-line no-console
      console.error(
        "[localforge] auto-continue to next feature failed:",
        err,
      );
    }
  });
}

/**
 * Start agents to fill all available slots for a project.
 * Returns an array of StartResult for each session that was started.
 */
export function startAllAgents(projectId: number): StartResult[] {
  const project = getProject(projectId);
  if (!project) {
    throw new OrchestratorError("Project not found", 404);
  }

  const results: StartResult[] = [];
  const runningCount = getRunningSessionsForProject(projectId).length;
  const slotsAvailable =
    getMaxConcurrentAgentsForProject(projectId) - runningCount;

  debugLog("START_ALL_AGENTS", { projectId, runningCount, slotsAvailable });

  for (let i = 0; i < slotsAvailable; i++) {
    const next = findNextReadyFeatureForProject(projectId);
    if (!next) {
      debugLog("START_ALL_AGENTS_NO_MORE_FEATURES", { projectId, startedCount: i });
      break;
    }
    try {
      const result = startOrchestrator(projectId);
      results.push(result);
    } catch (err) {
      debugLog("START_ALL_AGENTS_SLOT_ERROR", {
        projectId,
        slotFill: i + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  return results;
}

/**
 * Stop all running agent sessions for a project.
 * Returns an array of results for each session that was stopped.
 */
export function stopAllAgents(projectId: number): {
  stopped: boolean;
  session: AgentSessionRecord | null;
}[] {
  const sessions = getRunningSessionsForProject(projectId);
  debugLog("STOP_ALL_AGENTS", { projectId, sessionCount: sessions.length });

  const results: { stopped: boolean; session: AgentSessionRecord | null }[] = [];
  for (const session of sessions) {
    const result = stopOrchestratorSession(session.id);
    results.push(result);
  }
  return results;
}

/**
 * Returns information about all agent slots for a project.
 * Returns exactly `getMaxConcurrentAgentsForProject(projectId)` slots,
 * or the running count if it exceeds the configured limit (e.g. a user
 * just lowered the setting while agents are still in flight).
 */
export function getAgentSlots(projectId: number): AgentSlot[] {
  const slots: AgentSlot[] = [];
  const runningSessions: RunningSession[] = [];

  for (const rs of getState().running.values()) {
    if (rs.session.projectId === projectId) {
      runningSessions.push(rs);
    }
  }

  const configured = getMaxConcurrentAgentsForProject(projectId);
  const slotCount = Math.max(configured, runningSessions.length);

  for (let i = 0; i < slotCount; i++) {
    const rs = runningSessions[i];
    if (rs) {
      slots.push({
        slotIndex: i,
        running: true,
        sessionId: rs.session.id,
        featureId: rs.feature.id,
        featureTitle: rs.feature.title,
      });
    } else {
      slots.push({
        slotIndex: i,
        running: false,
      });
    }
  }

  return slots;
}

/**
 * Testing helper: reset orchestrator state. Only exported for unit tests /
 * dev scripts. Does NOT touch database rows.
 */
export function __resetStateForTests(): void {
  const state = getState();
  state.running.clear();
  state.events.removeAllListeners();
}
