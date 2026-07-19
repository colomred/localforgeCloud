import { truncateToTokens } from "./context";

/**
 * Prompt builders for every model call the engine makes. The overriding rule
 * is BREVITY: every token spent here is a token the model can't spend on
 * files and reasoning. No lectures, no multi-page workflows.
 */

/** Cap the brief's share of a session prompt. */
const BRIEF_TOKEN_CAP = 600;
/** Cap a progress note's share of a successor session prompt. */
const NOTE_TOKEN_CAP = 400;

export type FeatureSummary = {
  id: number;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
};

export type PlannedStep = {
  index: number;
  title: string;
  detail: string;
};

/* ------------------------------ PLAN pass ------------------------------ */

export function buildPlanSystemPrompt(): string {
  return (
    `You are a build planner for a small coding project. ` +
    `Decompose the feature into 3-8 small, concrete, ordered steps. ` +
    `Each step should be completable with a handful of file edits and verifiable by a type-check. ` +
    `Steps must not include scaffolding a new project, installing a framework, starting dev servers, or writing documentation — only real implementation work for this feature. ` +
    `Reply with JSON only.`
  );
}

export function buildPlanUserPrompt(opts: {
  brief: string | null;
  feature: FeatureSummary;
}): string {
  const parts: string[] = [];
  if (opts.brief) {
    parts.push(`PROJECT BRIEF:\n${truncateToTokens(opts.brief, BRIEF_TOKEN_CAP)}`);
  }
  parts.push(`FEATURE: ${opts.feature.title}`);
  if (opts.feature.description) {
    parts.push(`DESCRIPTION:\n${opts.feature.description}`);
  }
  if (opts.feature.acceptanceCriteria) {
    parts.push(`ACCEPTANCE CRITERIA:\n${opts.feature.acceptanceCriteria}`);
  }
  parts.push(`Plan the implementation steps now.`);
  return parts.join("\n\n");
}

/* ----------------------------- STEP session ---------------------------- */

export function buildStepSystemPrompt(projectDir: string): string {
  return (
    `You are a coding agent working in ${projectDir}. ` +
    `Implement ONE step of a feature using tools: read, search, write_file, patch, run_script, done. ` +
    `Rules: call one tool per reply. Never invent file contents — read before you edit. ` +
    `Make real file changes; prose does not count. ` +
    `Do not start dev servers; the harness runs and verifies the app. ` +
    `When the step is complete, call done with a one-line summary.`
  );
}

export function buildStepUserPrompt(opts: {
  brief: string | null;
  step: PlannedStep;
  stepCount: number;
  feature: FeatureSummary;
  completedSummaries: string[];
  note: string | null;
  fileWindows: Array<{ path: string; content: string }>;
}): string {
  const parts: string[] = [];
  if (opts.brief) {
    parts.push(`PROJECT BRIEF:\n${truncateToTokens(opts.brief, BRIEF_TOKEN_CAP)}`);
  }
  parts.push(
    `FEATURE: ${opts.feature.title}\nSTEP ${opts.step.index + 1} of ${opts.stepCount}: ${opts.step.title}\n${opts.step.detail}`,
  );
  if (opts.completedSummaries.length > 0) {
    parts.push(`ALREADY DONE:\n${opts.completedSummaries.map((s) => `- ${s}`).join("\n")}`);
  }
  if (opts.note) {
    parts.push(
      `NOTES FROM PREVIOUS ATTEMPT:\n${truncateToTokens(opts.note, NOTE_TOKEN_CAP)}`,
    );
  }
  for (const file of opts.fileWindows) {
    parts.push(`FILE ${file.path}:\n${file.content}`);
  }
  parts.push(`Implement this step now.`);
  return parts.join("\n\n");
}

/* ------------------------------ FIX session ---------------------------- */

export function buildFixUserPrompt(opts: {
  kind: string;
  errors: Array<{ file: string; line: number | null; message: string }>;
  fileWindows: Array<{ path: string; content: string }>;
}): string {
  const errorLines = opts.errors
    .map((e) => `- ${e.file}${e.line ? `:${e.line}` : ""} ${e.message}`)
    .join("\n");
  const parts = [
    `The ${opts.kind} check failed. Fix ONLY these errors:\n${errorLines}`,
  ];
  for (const file of opts.fileWindows) {
    parts.push(`FILE ${file.path}:\n${file.content}`);
  }
  parts.push(`Fix the errors now, then call done.`);
  return parts.join("\n\n");
}

/* --------------------------- Progress extraction ------------------------ */

export function buildExtractionUserPrompt(): string {
  return (
    `Stop. Summarise your progress on this step so another agent can continue: ` +
    `1) what is already done (files changed), 2) what remains, 3) any gotchas. ` +
    `Max 15 lines of plain text. Reply with the summary only.`
  );
}

/* ------------------------------ Summarizer ----------------------------- */

export function buildSummarizerSystemPrompt(): string {
  return (
    `You maintain a concise project brief for coding agents. ` +
    `Reply with the updated brief as plain markdown, max 40 lines. ` +
    `Sections: Stack, Layout (key files/dirs, one line each), Conventions, Built so far. ` +
    `No prose outside the brief.`
  );
}

export function buildSummarizerUserPrompt(opts: {
  oldBrief: string | null;
  featureTitle: string;
  changedFiles: string[];
  stepSummaries: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    opts.oldBrief
      ? `CURRENT BRIEF:\n${truncateToTokens(opts.oldBrief, BRIEF_TOKEN_CAP)}`
      : `CURRENT BRIEF: (none yet — write the first one)`,
  );
  parts.push(`JUST COMPLETED FEATURE: ${opts.featureTitle}`);
  if (opts.changedFiles.length > 0) {
    parts.push(`FILES TOUCHED:\n${opts.changedFiles.slice(0, 30).join("\n")}`);
  }
  if (opts.stepSummaries.length > 0) {
    parts.push(`WORK DONE:\n${opts.stepSummaries.map((s) => `- ${s}`).join("\n")}`);
  }
  parts.push(`Write the updated brief.`);
  return parts.join("\n\n");
}

/* ---------------------------- Feature generation ------------------------ */

export function buildFeatureGenSystemPrompt(): string {
  return (
    `You turn an app-idea conversation into a feature backlog. ` +
    `Produce 6-15 features. Each: a clear title, a 2-5 sentence description with concrete requirements, and acceptance criteria. ` +
    `Order by build sequence; use depends_on_indexes (indexes into your own list) for hard prerequisites only. ` +
    `Do NOT include features for project setup/scaffolding, installing frameworks, or deployment — the harness handles those. ` +
    `Reply with JSON only.`
  );
}

export function buildFeatureGenUserPrompt(transcript: string): string {
  return `CONVERSATION:\n${transcript}\n\nGenerate the feature backlog now.`;
}
