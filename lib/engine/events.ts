/**
 * Event vocabulary for the forge engine.
 *
 * These types are the contract between three layers:
 *   1. The engine runner child process, which emits them as JSON lines on
 *      stdout (one object per line).
 *   2. The orchestrator, which parses each line, persists what needs
 *      persisting (steps, logs with structured meta) and re-broadcasts the
 *      event over SSE.
 *   3. The UI, which imports the types to render step checklists, pipeline
 *      phases, verification chips and context meters.
 *
 * This module must stay dependency-free (no "server-only", no DB): it is
 * imported from the Next.js server, the runner child process and client
 * components alike.
 */

export type LogMessageType =
  | "info"
  | "action"
  | "error"
  | "screenshot"
  | "test_result";

/** Free-form prose log line, rendered verbatim in the activity panel. */
export type RunnerLogEvent = {
  type: "log";
  message: string;
  messageType: LogMessageType;
  screenshotPath?: string;
};

/** Terminal event: the runner is about to exit. */
export type RunnerDoneEvent = {
  type: "done";
  outcome: "success" | "failure";
  reason?: string;
  /** Index of the step the pipeline failed on, when applicable. */
  failedStepIndex?: number;
};

/** Result of the PLAN pass: the feature's step decomposition. */
export type RunnerPlanEvent = {
  type: "plan";
  featureId: number;
  steps: Array<{ index: number; title: string; detail: string }>;
};

export type StepEventStatus =
  | "planned"
  | "running"
  | "verifying"
  | "fixing"
  | "passed"
  | "failed";

/** A step changed status. Drives the kanban checklist. */
export type RunnerStepEvent = {
  type: "step";
  featureId: number;
  stepIndex: number;
  status: StepEventStatus;
  attempt: number;
  error?: string;
};

export type PipelinePhase =
  | "scaffold"
  | "plan"
  | "step"
  | "verify"
  | "fix"
  | "smoke"
  | "summarize";

/** The pipeline moved to a new phase. Drives the agent-pod status line. */
export type RunnerPhaseEvent = {
  type: "phase";
  featureId: number;
  phase: PipelinePhase;
  stepIndex?: number;
  stepCount?: number;
};

export type VerificationKind = "typecheck" | "lint" | "build" | "smoke" | "spec";

/** Outcome of one harness-run verification. */
export type RunnerVerificationEvent = {
  type: "verification";
  featureId: number;
  stepIndex?: number;
  kind: VerificationKind;
  ok: boolean;
  errorCount: number;
  summary: string;
};

/** Context-budget snapshot for the active session. Drives the context meter. */
export type RunnerBudgetEvent = {
  type: "budget";
  featureId: number;
  stepIndex?: number;
  usedTokens: number;
  limitTokens: number;
  /** True when this snapshot triggered a session handoff. */
  handoff: boolean;
};

/** Updated project brief content; the orchestrator writes it to disk. */
export type RunnerBriefEvent = {
  type: "brief";
  content: string;
};

/** Updated progress/failure note for the feature being worked on. */
export type RunnerNoteEvent = {
  type: "note";
  featureId: number;
  content: string;
};

export type RunnerEvent =
  | RunnerLogEvent
  | RunnerDoneEvent
  | RunnerPlanEvent
  | RunnerStepEvent
  | RunnerPhaseEvent
  | RunnerVerificationEvent
  | RunnerBudgetEvent
  | RunnerBriefEvent
  | RunnerNoteEvent;

export const RUNNER_EVENT_TYPES: readonly RunnerEvent["type"][] = [
  "log",
  "done",
  "plan",
  "step",
  "phase",
  "verification",
  "budget",
  "brief",
  "note",
];

/**
 * Parse one stdout line into a RunnerEvent. Returns null for blank lines,
 * non-JSON output (e.g. stray console noise from a dependency) and JSON
 * objects that don't carry a known `type` — callers treat those as raw text.
 */
export function parseRunnerLine(line: string): RunnerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const type = (obj as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (!(RUNNER_EVENT_TYPES as readonly string[]).includes(type)) return null;
  return obj as RunnerEvent;
}
