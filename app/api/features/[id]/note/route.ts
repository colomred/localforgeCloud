import { NextRequest, NextResponse } from "next/server";

import { getFeature } from "@/lib/features";
import { getProject } from "@/lib/projects";
import { readFeatureNote } from "@/lib/engine/memory";

/**
 * GET /api/features/:id/note
 *
 * Returns the feature's progress/failure note written by the forge engine's
 * `note` events (persisted by the orchestrator to
 * `<projectFolder>/.localforge/notes/feature-<id>.md`). The feature detail
 * dialog renders it in a collapsed "Notes" block so users can inspect what
 * the agent learned across attempts.
 *
 * Response:
 *   { content: string | null } — 200; content is null when no note exists
 *   { error: string }          — 400 on a bad id, 404 when feature missing
 */
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const featureId = parseId(id);
  if (featureId == null) {
    return NextResponse.json({ error: "Invalid feature id" }, { status: 400 });
  }
  const feature = getFeature(featureId);
  if (!feature) {
    return NextResponse.json({ error: "Feature not found" }, { status: 404 });
  }
  const project = getProject(feature.projectId);
  const content = project
    ? readFeatureNote(project.folderPath, featureId)
    : null;
  return NextResponse.json({ content });
}
