import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ContextBudget } from "./context";
import type {
  PipelinePhase,
  RunnerEvent,
  StepEventStatus,
  VerificationKind,
} from "./events";
import { runLoop, type LoopResult } from "./loop";
import { readBrief, readFeatureNote } from "./memory";
import {
  buildExtractionUserPrompt,
  buildFixUserPrompt,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  buildStepSystemPrompt,
  buildStepUserPrompt,
  buildSummarizerSystemPrompt,
  buildSummarizerUserPrompt,
  type FeatureSummary,
} from "./prompts";
import { ProviderClient, type ChatMessage } from "./provider/client";
import { detectContextWindow, type ProviderKind } from "./provider/context-window";
import { applyTemplate, templateExists } from "./scaffold";
import { generateStructured } from "./structured";
import { CODING_TOOLS } from "./tools";
import {
  runBuild,
  runLint,
  runSmoke,
  runSpecFile,
  runTypecheck,
  type ParsedError,
  type VerificationOutcome,
} from "./verify";

/**
 * The per-feature pipeline: the deterministic state machine that replaces
 * "one giant model session per feature".
 *
 *   SCAFFOLD? -> PLAN -> per step: (STEP_SESSION -> VERIFY -> FIX x<=2)
 *            -> SMOKE -> SUMMARIZE -> done
 *
 * The model is only invoked inside PLAN / STEP / FIX / SUMMARIZE, always in
 * fresh, small, token-budgeted sessions. Verification is harness-run.
 * All observable behavior flows through the event sink as RunnerEvents.
 */

export type PipelineJob = {
  sessionId: number;
  feature: FeatureSummary;
  projectDir: string;
  projectName: string;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  devServerPort: string;
  template: string;
  coderPrompt: string;
  contextWindowFallback: number;
  specGeneration: boolean;
  harnessRoot: string;
  /** Absolute path for the smoke screenshot (inside harness screenshots/). */
  screenshotPath: string | null;
  /** Screenshot path relative to the harness root, for the UI route. */
  screenshotRelPath: string | null;
  /** Existing steps from a previous attempt; empty for a fresh feature. */
  existingSteps: Array<{ index: number; title: string; detail: string; status: string }>;
};

export type PipelineResult = {
  outcome: "success" | "failure";
  reason?: string;
  failedStepIndex?: number;
};

export type EventSink = (event: RunnerEvent) => void;

const STEP_MAX_TURNS = 25;
const FIX_MAX_TURNS = 12;
const MAX_FIX_ROUNDS = 2;
const MAX_SUCCESSOR_SESSIONS = 2;
const FILE_WINDOW_LINES = 80;

const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        detail: z.string().max(2000),
        files: z.array(z.string()).max(6).default([]),
        verify: z.enum(["typecheck", "build", "none"]).default("typecheck"),
      }),
    )
    .min(1)
    .max(10),
});
type Plan = z.infer<typeof PlanSchema>;

export async function runPipeline(
  job: PipelineJob,
  sink: EventSink,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const log = (message: string, messageType: "info" | "action" | "error" = "info") =>
    sink({ type: "log", message, messageType });
  const phase = (p: PipelinePhase, stepIndex?: number, stepCount?: number) =>
    sink({ type: "phase", featureId: job.feature.id, phase: p, stepIndex, stepCount });
  const stepEvent = (
    stepIndex: number,
    status: StepEventStatus,
    attempt: number,
    error?: string,
  ) => sink({ type: "step", featureId: job.feature.id, stepIndex, status, attempt, error });
  const verificationEvent = (
    kind: VerificationKind,
    outcome: VerificationOutcome,
    stepIndex?: number,
  ) =>
    sink({
      type: "verification",
      featureId: job.feature.id,
      stepIndex,
      kind,
      ok: outcome.ok,
      errorCount: outcome.errorCount,
      summary: outcome.summary,
    });

  /* ------------------------- provider + budget setup ------------------- */

  const client = new ProviderClient({ baseUrl: job.baseUrl, model: job.model });
  const window = await detectContextWindow({
    provider: job.provider,
    baseUrl: job.baseUrl,
    model: job.model,
    fallbackTokens: job.contextWindowFallback,
  });
  log(
    `Context window: ${window.tokens} tokens (${window.source === "fallback" ? "from settings" : `detected via ${window.source}`})`,
  );

  const newBudget = () => new ContextBudget(window.tokens);

  /* ----------------------------- SCAFFOLD ------------------------------ */

  const hasPackageJson = fs.existsSync(path.join(job.projectDir, "package.json"));
  if (!hasPackageJson) {
    if (templateExists(job.template, job.harnessRoot)) {
      phase("scaffold");
      log(`Scaffolding ${job.template} template (harness-run, zero model turns)`, "action");
      const scaffold = await applyTemplate({
        projectDir: job.projectDir,
        template: job.template,
        projectName: job.projectName,
        devServerPort: job.devServerPort,
        harnessRoot: job.harnessRoot,
      });
      if (!scaffold.installOk) {
        log(`npm install failed during scaffolding:\n${scaffold.installOutput}`, "error");
        return { outcome: "failure", reason: "template npm install failed" };
      }
      log(`Template applied and dependencies installed`);
    } else if (job.template !== "none") {
      log(
        `No template "${job.template}" available — the agent will work in the empty folder`,
        "error",
      );
    }
  }

  /* ------------------------------- PLAN -------------------------------- */

  const brief = readBrief(job.projectDir);
  const note = readFeatureNote(job.projectDir, job.feature.id);

  let steps: Array<{ index: number; title: string; detail: string; files: string[]; verify: "typecheck" | "build" | "none" }>;
  const resumableSteps = job.existingSteps.filter((s) => s.status === "passed");
  const canResume = job.existingSteps.length > 0;

  if (canResume) {
    // Retry: keep the existing decomposition, resume at the first
    // non-passed step. Files/verify metadata is not persisted, so default it.
    steps = job.existingSteps
      .sort((a, b) => a.index - b.index)
      .map((s) => ({
        index: s.index,
        title: s.title,
        detail: s.detail,
        files: [],
        verify: "typecheck" as const,
      }));
    log(
      `Resuming with existing plan: ${resumableSteps.length}/${steps.length} steps already passed`,
    );
  } else {
    phase("plan");
    log(`Planning implementation steps for "${job.feature.title}"`, "action");
    let plan: Plan;
    try {
      plan = await generateStructured({
        client,
        schema: PlanSchema,
        name: "plan",
        messages: [
          { role: "system", content: buildPlanSystemPrompt() },
          { role: "user", content: buildPlanUserPrompt({ brief, feature: job.feature }) },
        ],
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Planning failed: ${message}`, "error");
      return { outcome: "failure", reason: `plan generation failed: ${message}` };
    }
    steps = plan.steps.map((s, i) => ({
      index: i,
      title: s.title,
      detail: s.detail,
      files: s.files,
      verify: s.verify,
    }));
  }

  sink({
    type: "plan",
    featureId: job.feature.id,
    steps: steps.map((s) => ({ index: s.index, title: s.title, detail: s.detail })),
  });

  const passedIndexes = new Set(resumableSteps.map((s) => s.index));
  const completedSummaries: string[] = steps
    .filter((s) => passedIndexes.has(s.index))
    .map((s) => s.title);
  const changedFiles = new Set<string>();

  /* ---------------------------- STEP sessions --------------------------- */

  for (const step of steps) {
    if (signal.aborted) return { outcome: "failure", reason: "aborted" };
    if (passedIndexes.has(step.index)) {
      stepEvent(step.index, "passed", 0);
      continue;
    }

    const stepOk = await runStepWithVerification(step);
    if (!stepOk.ok) {
      stepEvent(step.index, "failed", stepOk.attempt, stepOk.reason);
      emitFailureNote(step.index, stepOk.reason ?? "unknown failure");
      return {
        outcome: "failure",
        reason: `step ${step.index + 1} (${step.title}): ${stepOk.reason}`,
        failedStepIndex: step.index,
      };
    }
    completedSummaries.push(stepOk.summary || step.title);
    stepEvent(step.index, "passed", stepOk.attempt);
  }

  /* ------------------------------- SMOKE -------------------------------- */

  phase("smoke");
  const build = await runBuild(job.projectDir);
  if (build) {
    verificationEvent("build", build);
    if (!build.ok) {
      log(`Build failed — attempting a focused fix`, "error");
      const fixed = await runFixSession(build.errors, "build", undefined);
      const rebuild = fixed ? await runBuild(job.projectDir) : null;
      if (rebuild) verificationEvent("build", rebuild);
      if (!rebuild?.ok) {
        emitFailureNote(null, `build failed: ${build.summary}`);
        return { outcome: "failure", reason: "build failed after fix attempt" };
      }
    }
  }

  const smoke = await runSmoke({
    projectDir: job.projectDir,
    port: job.devServerPort,
    screenshotPath: job.screenshotPath,
  });
  verificationEvent("smoke", smoke);
  if (job.screenshotRelPath && job.screenshotPath && fs.existsSync(job.screenshotPath)) {
    sink({
      type: "log",
      message: `Captured verification screenshot: ${job.screenshotRelPath}`,
      messageType: "screenshot",
      screenshotPath: job.screenshotRelPath,
    });
  }
  if (!smoke.ok) {
    emitFailureNote(null, `smoke failed: ${smoke.summary}`);
    return { outcome: "failure", reason: smoke.summary };
  }

  /* ----------------------- Tier 3: spec generation ---------------------- */

  if (job.specGeneration) {
    await runSpecGeneration();
  }

  /* ----------------------------- SUMMARIZE ------------------------------ */

  phase("summarize");
  try {
    const updated = await client.chat({
      messages: [
        { role: "system", content: buildSummarizerSystemPrompt() },
        {
          role: "user",
          content: buildSummarizerUserPrompt({
            oldBrief: brief,
            featureTitle: job.feature.title,
            changedFiles: [...changedFiles],
            stepSummaries: completedSummaries,
          }),
        },
      ],
      maxTokens: 1200,
      temperature: 0.2,
      signal,
    });
    if (updated.content.trim()) {
      sink({ type: "brief", content: updated.content.trim() });
    }
  } catch (err) {
    // A failed brief update never fails the feature.
    log(
      `Brief update skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { outcome: "success" };

  /* ======================= helpers (closures) =========================== */

  function trackToolEvents(stepIndex: number) {
    return (event: Parameters<NonNullable<Parameters<typeof runLoop>[0]["onEvent"]>>[0]) => {
      if (event.type === "tool_start") {
        const p = typeof event.args.path === "string" ? `: ${event.args.path}` : "";
        log(`[step ${stepIndex + 1}] ${event.name}${p}`, "action");
        if (
          (event.name === "write_file" || event.name === "patch") &&
          typeof event.args.path === "string"
        ) {
          changedFiles.add(event.args.path);
        }
      } else if (event.type === "budget") {
        sink({
          type: "budget",
          featureId: job.feature.id,
          stepIndex,
          usedTokens: event.snapshot.usedTokens,
          limitTokens: event.snapshot.limitTokens,
          handoff: false,
        });
      } else if (event.type === "malformed") {
        log(`[step ${stepIndex + 1}] malformed tool call (${event.detail})`, "error");
      }
    };
  }

  function fileWindows(
    files: string[],
    around?: Map<string, number>,
  ): Array<{ path: string; content: string }> {
    const out: Array<{ path: string; content: string }> = [];
    for (const rel of files.slice(0, 4)) {
      const abs = path.resolve(job.projectDir, rel);
      if (!abs.startsWith(path.resolve(job.projectDir))) continue;
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const center = around?.get(rel);
      let start = 0;
      let end = Math.min(lines.length, FILE_WINDOW_LINES);
      if (center != null) {
        start = Math.max(0, center - Math.floor(FILE_WINDOW_LINES / 2));
        end = Math.min(lines.length, start + FILE_WINDOW_LINES);
      }
      const width = String(end).length;
      const numbered = lines
        .slice(start, end)
        .map((l, i) => `${String(start + i + 1).padStart(width)}| ${l}`)
        .join("\n");
      const suffix =
        lines.length > end ? `\n(… ${lines.length - end} more lines)` : "";
      out.push({ path: rel, content: numbered + suffix });
    }
    return out;
  }

  async function runStepWithVerification(step: {
    index: number;
    title: string;
    detail: string;
    files: string[];
    verify: "typecheck" | "build" | "none";
  }): Promise<{ ok: boolean; attempt: number; summary: string; reason?: string }> {
    let attempt = 1;
    phase("step", step.index, steps.length);
    stepEvent(step.index, "running", attempt);

    const session = await runStepSession(step);
    if (!session.ok) {
      return { ok: false, attempt, summary: "", reason: session.reason };
    }

    /* verify + fix loop */
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      if (signal.aborted) return { ok: false, attempt, summary: "", reason: "aborted" };
      if (step.verify === "none") break;

      phase("verify", step.index, steps.length);
      stepEvent(step.index, "verifying", attempt);
      const check = await runTypecheck(job.projectDir);
      if (!check) break; // no tsconfig — nothing to verify against
      verificationEvent("typecheck", check, step.index);
      if (check.ok) break;

      if (round === MAX_FIX_ROUNDS) {
        return {
          ok: false,
          attempt,
          summary: "",
          reason: `typecheck still failing after ${MAX_FIX_ROUNDS} fix rounds: ${check.summary}`,
        };
      }

      phase("fix", step.index, steps.length);
      attempt++;
      stepEvent(step.index, "fixing", attempt);
      const fixed = await runFixSession(check.errors, "typecheck", step.index);
      if (!fixed) {
        return { ok: false, attempt, summary: "", reason: "fix session failed" };
      }
    }

    return { ok: true, attempt, summary: session.summary };
  }

  async function runStepSession(step: {
    index: number;
    title: string;
    detail: string;
    files: string[];
  }): Promise<{ ok: boolean; summary: string; reason?: string }> {
    let carryNote = note; // previous attempt's note on the first session
    for (let successor = 0; successor <= MAX_SUCCESSOR_SESSIONS; successor++) {
      if (signal.aborted) return { ok: false, summary: "", reason: "aborted" };
      const budget = newBudget();
      const result = await runLoop({
        client,
        budget,
        tools: CODING_TOOLS,
        toolCtx: { projectDir: job.projectDir },
        systemPrompt:
          buildStepSystemPrompt(job.projectDir) +
          (job.coderPrompt ? `\nProject-specific instructions: ${job.coderPrompt}` : ""),
        userPrompt: buildStepUserPrompt({
          brief,
          step,
          stepCount: steps.length,
          feature: job.feature,
          completedSummaries,
          note: carryNote,
          fileWindows: fileWindows(step.files),
        }),
        maxTurns: STEP_MAX_TURNS,
        signal,
        onEvent: trackToolEvents(step.index),
      });

      if (result.outcome === "done") {
        return { ok: true, summary: result.summary };
      }
      if (result.outcome === "aborted") {
        return { ok: false, summary: "", reason: "aborted" };
      }
      if (result.outcome === "error" || result.outcome === "malformed") {
        return {
          ok: false,
          summary: "",
          reason: `${result.outcome}: ${result.error ?? "unknown"}`,
        };
      }

      // budget / max_turns: extract a progress note and hand off to a fresh
      // successor session instead of limping on with a poisoned context.
      if (successor === MAX_SUCCESSOR_SESSIONS) {
        return {
          ok: false,
          summary: "",
          reason: `step did not finish within ${MAX_SUCCESSOR_SESSIONS + 1} sessions (${result.outcome})`,
        };
      }
      sink({
        type: "budget",
        featureId: job.feature.id,
        stepIndex: step.index,
        usedTokens: result.budget.usedTokens,
        limitTokens: result.budget.limitTokens,
        handoff: true,
      });
      log(
        `[step ${step.index + 1}] context ${result.outcome === "budget" ? "budget reached" : "turn cap reached"} — handing off to a fresh session`,
        "action",
      );
      carryNote = await extractProgressNote(result);
      if (carryNote) {
        sink({ type: "note", featureId: job.feature.id, content: carryNote });
      }
    }
    return { ok: false, summary: "", reason: "unreachable" };
  }

  async function extractProgressNote(previous: LoopResult): Promise<string | null> {
    try {
      const messages: ChatMessage[] = [
        ...previous.messages,
        { role: "user", content: buildExtractionUserPrompt() },
      ];
      const result = await client.chat({
        messages,
        maxTokens: 600,
        temperature: 0.2,
        signal,
      });
      return result.content.trim() || null;
    } catch {
      return null;
    }
  }

  async function runFixSession(
    errors: ParsedError[],
    kind: string,
    stepIndex: number | undefined,
  ): Promise<boolean> {
    const around = new Map<string, number>();
    const files: string[] = [];
    for (const err of errors) {
      if (!files.includes(err.file)) files.push(err.file);
      if (err.line != null && !around.has(err.file)) around.set(err.file, err.line);
    }
    const result = await runLoop({
      client,
      budget: newBudget(),
      tools: CODING_TOOLS,
      toolCtx: { projectDir: job.projectDir },
      systemPrompt: buildStepSystemPrompt(job.projectDir),
      userPrompt: buildFixUserPrompt({
        kind,
        errors,
        fileWindows: fileWindows(files, around),
      }),
      maxTurns: FIX_MAX_TURNS,
      signal,
      onEvent: trackToolEvents(stepIndex ?? -1),
    });
    return result.outcome === "done";
  }

  async function runSpecGeneration(): Promise<void> {
    const specRel = `tests/feature-${job.feature.id}.spec.ts`;
    log(`Spec generation (Tier 3): asking the model to write ${specRel}`, "action");
    const result = await runLoop({
      client,
      budget: newBudget(),
      tools: CODING_TOOLS,
      toolCtx: { projectDir: job.projectDir },
      systemPrompt: buildStepSystemPrompt(job.projectDir),
      userPrompt:
        `Write a Playwright spec at ${specRel} covering the feature "${job.feature.title}". ` +
        `Base URL http://localhost:${job.devServerPort}. Keep it to 1-3 focused tests. ` +
        `Use write_file, then call done. Do not run it.`,
      maxTurns: 8,
      signal,
    });
    if (result.outcome !== "done" || !fs.existsSync(path.join(job.projectDir, specRel))) {
      log(`Spec generation skipped (${result.outcome})`, "info");
      return;
    }
    const { hasDependency } = await import("./verify");
    if (!hasDependency(job.projectDir, "@playwright/test")) {
      log("Spec written but @playwright/test is not a project dependency — not executed", "info");
      return;
    }
    const spec = await runSpecFile(job.projectDir, specRel);
    verificationEvent("spec", spec);
    // Non-fatal by design: results surface as the kanban badge only.
  }

  function emitFailureNote(stepIndex: number | null, reason: string): void {
    const stepLine =
      stepIndex != null
        ? `Failed at step ${stepIndex + 1}/${steps.length}: ${steps[stepIndex]?.title ?? "?"}`
        : "Failed after all steps passed";
    const done = completedSummaries.length
      ? `Done so far:\n${completedSummaries.map((s) => `- ${s}`).join("\n")}`
      : "Nothing completed yet.";
    const files = changedFiles.size
      ? `Files touched: ${[...changedFiles].join(", ")}`
      : "";
    sink({
      type: "note",
      featureId: job.feature.id,
      content: [stepLine, `Reason: ${reason}`, done, files]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
}
