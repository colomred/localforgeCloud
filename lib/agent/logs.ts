import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { agentLogs, features } from "../db/schema";

/**
 * Agent log helpers.
 *
 * Every message emitted by a running agent session (whether a coding run or
 * the bootstrapper AI conversation) is persisted to the `agent_logs` table
 * so the UI can replay history after a reload and per-feature detail pages
 * can show historical runs. The live agent-activity panel subscribes to the
 * orchestrator's in-memory pub/sub for real-time streaming, and uses these
 * stored rows to bootstrap when reconnecting mid-session.
 */

export type AgentLogRecord = typeof agentLogs.$inferSelect;
export type AgentMessageType =
  | "info"
  | "action"
  | "error"
  | "screenshot"
  | "test_result";

export type AppendAgentLogInput = {
  sessionId: number;
  featureId?: number | null;
  message: string;
  messageType?: AgentMessageType;
  screenshotPath?: string | null;
  /** JSON payload for structured pipeline events (phase/verification/budget). */
  meta?: string | null;
};

/** Insert a log row and return the inserted record. */
export function appendAgentLog(input: AppendAgentLogInput): AgentLogRecord {
  return db
    .insert(agentLogs)
    .values({
      sessionId: input.sessionId,
      featureId: input.featureId ?? null,
      message: input.message,
      messageType: input.messageType ?? "info",
      screenshotPath: input.screenshotPath ?? null,
      meta: input.meta ?? null,
    })
    .returning()
    .get();
}

/** List log rows for a session, ordered by id ascending (oldest first). */
export function listAgentLogsForSession(sessionId: number): AgentLogRecord[] {
  return db
    .select()
    .from(agentLogs)
    .where(eq(agentLogs.sessionId, sessionId))
    .all()
    .sort((a, b) => a.id - b.id);
}

/** List log rows for a specific feature across all sessions. */
export function listAgentLogsForFeature(featureId: number): AgentLogRecord[] {
  return db
    .select()
    .from(agentLogs)
    .where(eq(agentLogs.featureId, featureId))
    .all()
    .sort((a, b) => a.id - b.id);
}

/**
 * Verification badge for the kanban card, derived from the forge engine's
 * `verification` events (persisted as JSON in `agent_logs.meta` on
 * test_result rows). Spec runs carry real pass/fail counts; other kinds
 * (smoke/build/typecheck/lint) collapse to a single pass-or-fail check.
 */
export type FeatureTestResult = {
  passed: number;
  failed: number;
  total: number;
  ok: boolean;
  durationMs: number | null;
  rawMessage: string;
  createdAt: string;
};

/**
 * Fetch the most recent `test_result` log row for each of the supplied feature
 * ids and return a map `featureId -> FeatureTestResult`. Features without a
 * test_result row are simply omitted from the map.
 *
 * Used by `GET /api/projects/:id/features` so every kanban card carries the
 * counts from its latest Playwright run (Feature #96 verification step 4).
 */
export function getLatestTestResultsForFeatures(
  featureIds: number[],
): Map<number, FeatureTestResult> {
  const map = new Map<number, FeatureTestResult>();
  if (!Array.isArray(featureIds) || featureIds.length === 0) return map;

  const rows = db
    .select()
    .from(agentLogs)
    .where(
      and(
        eq(agentLogs.messageType, "test_result"),
        inArray(agentLogs.featureId, featureIds),
      ),
    )
    .all();

  // Sort DESC by id so the first row we encounter for a feature is the latest.
  rows.sort((a, b) => b.id - a.id);
  for (const row of rows) {
    if (row.featureId == null) continue;
    if (map.has(row.featureId)) continue;
    const parsed = parseVerificationMeta(row.meta, row.message);
    if (parsed) {
      parsed.createdAt = row.createdAt;
      map.set(row.featureId, parsed);
    }
  }
  return map;
}

/** Map a forge `verification` event onto the FeatureTestResult badge shape. */
function parseVerificationMeta(
  meta: string | null,
  message: string,
): FeatureTestResult | null {
  if (!meta) return null;
  let event: {
    type?: string;
    kind?: string;
    ok?: boolean;
    errorCount?: number;
    passed?: number;
    failed?: number;
  };
  try {
    event = JSON.parse(meta);
  } catch {
    return null;
  }
  if (event.type !== "verification" || typeof event.ok !== "boolean") {
    return null;
  }
  const hasCounts =
    typeof event.passed === "number" && typeof event.failed === "number";
  const passed = hasCounts ? event.passed! : event.ok ? 1 : 0;
  const failed = hasCounts
    ? event.failed!
    : event.ok
      ? 0
      : Math.max(1, event.errorCount ?? 1);
  return {
    passed,
    failed,
    total: passed + failed,
    ok: event.ok,
    durationMs: null,
    rawMessage: message,
    createdAt: "",
  };
}

/**
 * Convenience wrapper: load every feature id in a project, then call
 * getLatestTestResultsForFeatures. Keeps the API route thin.
 */
export function getLatestTestResultsForProject(
  projectId: number,
): Map<number, FeatureTestResult> {
  const rows = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.projectId, projectId))
    .all();
  return getLatestTestResultsForFeatures(rows.map((r) => r.id));
}
