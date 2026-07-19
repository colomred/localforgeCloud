/**
 * Forge engine runner — the thin child-process entry the orchestrator spawns
 * per feature (via `node --import tsx scripts/engine-runner.ts`).
 *
 * Role: read the job file, run the pipeline, stream RunnerEvents as JSON
 * lines on stdout. No DB access, no settings reads — the orchestrator is the
 * single source of configuration (job file) and the single writer of state.
 *
 * stdout protocol: one JSON object per line; see lib/engine/events.ts.
 */

import fs from "node:fs";
import { runPipeline, type PipelineJob } from "../lib/engine/pipeline";
import type { RunnerEvent } from "../lib/engine/events";

function emit(event: RunnerEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobFile = args["job-file"];
  if (!jobFile) {
    emit({ type: "log", message: "engine-runner: --job-file is required", messageType: "error" });
    emit({ type: "done", outcome: "failure", reason: "no job file" });
    process.exit(1);
  }

  let job: PipelineJob;
  try {
    job = JSON.parse(fs.readFileSync(jobFile, "utf8")) as PipelineJob;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "log", message: `engine-runner: cannot read job file: ${message}`, messageType: "error" });
    emit({ type: "done", outcome: "failure", reason: "unreadable job file" });
    process.exit(1);
  }

  const abort = new AbortController();
  let doneEmitted = false;
  const emitDone = (outcome: "success" | "failure", reason?: string, failedStepIndex?: number) => {
    if (doneEmitted) return;
    doneEmitted = true;
    emit({ type: "done", outcome, reason, failedStepIndex });
  };

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      emit({ type: "log", message: `Received ${sig} — aborting`, messageType: "error" });
      abort.abort();
      emitDone("failure", `terminated (${sig})`);
      setTimeout(() => process.exit(130), 250).unref();
    });
  }

  emit({
    type: "log",
    message: `Forge engine starting on feature #${job.feature.id}: "${job.feature.title}" (${job.model} via ${job.provider})`,
    messageType: "info",
  });

  try {
    const result = await runPipeline(job, emit, abort.signal);
    emitDone(result.outcome, result.reason, result.failedStepIndex);
    process.stdout.write("", () => process.exit(result.outcome === "success" ? 0 : 1));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "log", message: `Pipeline crashed: ${message}`, messageType: "error" });
    emitDone("failure", `pipeline crash: ${message}`);
    process.stdout.write("", () => process.exit(1));
  }
}

void main();
