import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { getProject } from "@/lib/projects";
import { briefAbsolutePath, readBrief, writeBrief } from "@/lib/engine/memory";

/**
 * GET  /api/projects/:id/brief - read the persistent project brief
 *      (.localforge/brief.md). Returns { content, updatedAt } where both are
 *      null when the brief has not been written yet. `updatedAt` is the file's
 *      mtime as an ISO string.
 * PUT  /api/projects/:id/brief - overwrite the brief. Body: { content: string }.
 *      Content is size-limited to 64KB (same cap the engine memory layer
 *      enforces on write).
 */

type RouteContext = { params: Promise<{ id: string }> };

/** Max accepted brief size in bytes — mirrors MAX_MEMORY_FILE_BYTES in lib/engine/memory.ts. */
const MAX_BRIEF_BYTES = 64 * 1024;

function parseId(idStr: string): number | null {
  const n = Number.parseInt(idStr, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const numericId = parseId(id);
  if (numericId == null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const project = getProject(numericId);
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const content = readBrief(project.folderPath);

  let updatedAt: string | null = null;
  try {
    updatedAt = fs
      .statSync(briefAbsolutePath(project.folderPath))
      .mtime.toISOString();
  } catch {
    // File doesn't exist yet — updatedAt stays null.
  }

  return NextResponse.json({ content, updatedAt });
}

export async function PUT(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const numericId = parseId(id);
  if (numericId == null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const project = getProject(numericId);
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { content } = (body ?? {}) as { content?: unknown };
  if (typeof content !== "string") {
    return NextResponse.json(
      { error: "content must be a string" },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(content, "utf8") > MAX_BRIEF_BYTES) {
    return NextResponse.json(
      { error: "content exceeds the 64KB brief size limit" },
      { status: 413 },
    );
  }

  writeBrief(project.folderPath, content);
  return NextResponse.json({ ok: true });
}
