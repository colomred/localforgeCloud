import "server-only";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "./db";
import { features, featureSteps } from "./db/schema";

/**
 * Feature-step domain helpers.
 *
 * Steps are the unit of model work in the forge engine: the per-feature PLAN
 * pass decomposes a feature into 3-8 small steps, each implemented by a
 * fresh micro-session and verified by the harness. Rows live in
 * `feature_steps`, written exclusively by the orchestrator as it parses
 * pipeline events from the engine runner; the kanban card checklist and the
 * feature detail dialog render from them.
 */

export type FeatureStepRecord = typeof featureSteps.$inferSelect;

export type FeatureStepStatus =
  | "planned"
  | "running"
  | "verifying"
  | "fixing"
  | "passed"
  | "failed"
  | "skipped";

export const FEATURE_STEP_STATUSES: readonly FeatureStepStatus[] = [
  "planned",
  "running",
  "verifying",
  "fixing",
  "passed",
  "failed",
  "skipped",
];

export function isFeatureStepStatus(s: string): s is FeatureStepStatus {
  return (FEATURE_STEP_STATUSES as readonly string[]).includes(s);
}

export type PlannedStepInput = {
  stepIndex: number;
  title: string;
  detail?: string | null;
};

/**
 * Replace the step list for a feature with a freshly-planned one.
 *
 * Steps whose index matches an existing row are updated in place so a
 * re-plan after a retry keeps ids stable (and keeps `passed` rows' history
 * meaningful); indexes not present in the new plan are deleted.
 */
export function replaceStepsForFeature(
  featureId: number,
  steps: PlannedStepInput[],
): FeatureStepRecord[] {
  const now = new Date().toISOString();
  const keepIndexes = steps.map((s) => s.stepIndex);

  if (keepIndexes.length === 0) {
    db.delete(featureSteps)
      .where(eq(featureSteps.featureId, featureId))
      .run();
    return [];
  }

  db.delete(featureSteps)
    .where(
      and(
        eq(featureSteps.featureId, featureId),
        notInArray(featureSteps.stepIndex, keepIndexes),
      ),
    )
    .run();

  for (const step of steps) {
    const existing = db
      .select()
      .from(featureSteps)
      .where(
        and(
          eq(featureSteps.featureId, featureId),
          eq(featureSteps.stepIndex, step.stepIndex),
        ),
      )
      .get();
    if (existing) {
      db.update(featureSteps)
        .set({
          title: step.title,
          detail: step.detail ?? null,
          updatedAt: now,
        })
        .where(eq(featureSteps.id, existing.id))
        .run();
    } else {
      db.insert(featureSteps)
        .values({
          featureId,
          stepIndex: step.stepIndex,
          title: step.title,
          detail: step.detail ?? null,
          status: "planned",
        })
        .run();
    }
  }
  return listStepsForFeature(featureId);
}

export type UpdateStepStatusInput = {
  status: FeatureStepStatus;
  /** When set, replaces last_error; pass null to clear it. */
  error?: string | null;
  /** When set, overwrites the attempts counter (from the runner's event). */
  attempt?: number;
};

export function updateStepStatus(
  featureId: number,
  stepIndex: number,
  input: UpdateStepStatusInput,
): FeatureStepRecord | null {
  const existing = db
    .select()
    .from(featureSteps)
    .where(
      and(
        eq(featureSteps.featureId, featureId),
        eq(featureSteps.stepIndex, stepIndex),
      ),
    )
    .get();
  if (!existing) return null;

  const patch: Partial<typeof featureSteps.$inferInsert> = {
    status: input.status,
    updatedAt: new Date().toISOString(),
  };
  if (input.error !== undefined) patch.lastError = input.error;
  if (typeof input.attempt === "number") patch.attempts = input.attempt;

  return (
    db
      .update(featureSteps)
      .set(patch)
      .where(eq(featureSteps.id, existing.id))
      .returning()
      .get() ?? null
  );
}

export function listStepsForFeature(featureId: number): FeatureStepRecord[] {
  return db
    .select()
    .from(featureSteps)
    .where(eq(featureSteps.featureId, featureId))
    .all()
    .sort((a, b) => a.stepIndex - b.stepIndex);
}

/**
 * Bulk step fetch for a whole project, keyed by feature id. One query — used
 * by the features API so the kanban board renders checklists without N+1.
 */
export function listStepsForProject(
  projectId: number,
): Map<number, FeatureStepRecord[]> {
  const featureIds = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.projectId, projectId))
    .all()
    .map((r) => r.id);

  const out = new Map<number, FeatureStepRecord[]>();
  if (featureIds.length === 0) return out;

  const rows = db
    .select()
    .from(featureSteps)
    .where(inArray(featureSteps.featureId, featureIds))
    .all()
    .sort((a, b) => a.stepIndex - b.stepIndex);

  for (const row of rows) {
    const list = out.get(row.featureId);
    if (list) {
      list.push(row);
    } else {
      out.set(row.featureId, [row]);
    }
  }
  return out;
}

/**
 * Prepare a feature's steps for a retry: everything that already `passed`
 * stays passed (the pipeline resumes at the first non-passed step); all other
 * statuses reset to `planned` with their error cleared.
 */
export function resetStepsForRetry(featureId: number): FeatureStepRecord[] {
  db.update(featureSteps)
    .set({
      status: "planned",
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(featureSteps.featureId, featureId),
        notInArray(featureSteps.status, ["passed"]),
      ),
    )
    .run();
  return listStepsForFeature(featureId);
}

/** Indexes of steps that already passed — sent to the runner so it resumes. */
export function listPassedStepIndexes(featureId: number): number[] {
  return listStepsForFeature(featureId)
    .filter((s) => s.status === "passed")
    .map((s) => s.stepIndex);
}
