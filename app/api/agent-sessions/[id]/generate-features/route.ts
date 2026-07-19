import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  closeAgentSession,
  getAgentSession,
  listChatMessages,
} from "@/lib/agent-sessions";
import {
  buildFeatureGenSystemPrompt,
  buildFeatureGenUserPrompt,
} from "@/lib/engine/prompts";
import { ProviderClient } from "@/lib/engine/provider/client";
import {
  generateStructured,
  StructuredOutputError,
} from "@/lib/engine/structured";
import {
  addDependency,
  createFeature,
  listFeaturesForProject,
} from "@/lib/features";
import { getProject } from "@/lib/projects";
import { getEffectiveProviderConfig } from "@/lib/settings";

export const runtime = "nodejs";
// Feature generation against a local model can take minutes; extend
// Next.js's per-request timeout so the model has room to finish.
export const maxDuration = 600;

type RouteContext = { params: Promise<{ id: string }> };

function parseId(idStr: string): number | null {
  const n = Number.parseInt(idStr, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const FeatureListSchema = z.object({
  features: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().min(10).max(3000),
        acceptance_criteria: z.string().max(3000).optional(),
        category: z.enum(["functional", "style"]).default("functional"),
        depends_on_indexes: z
          .array(z.number().int().min(0))
          .max(10)
          .default([]),
      }),
    )
    .min(3)
    .max(20),
});

/**
 * POST /api/agent-sessions/:id/generate-features
 *
 * Turns the bootstrapper chat transcript into a feature backlog via ONE
 * structured model call on the forge engine — no agent session, no tools,
 * no filesystem. The model returns a JSON feature list (schema-constrained
 * where the provider supports it, extracted + zod-validated + one repair
 * round otherwise); the harness inserts the rows and resolves
 * depends_on_indexes to real feature ids through the validated CRUD in
 * lib/features.ts (cycle checks included).
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const sessionId = parseId(id);
  if (sessionId == null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const session = getAgentSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (session.sessionType !== "bootstrapper") {
    return NextResponse.json(
      { error: "Not a bootstrapper session" },
      { status: 400 },
    );
  }

  const history = listChatMessages(sessionId);
  if (history.length === 0) {
    return NextResponse.json(
      { error: "No conversation yet — send a message first" },
      { status: 400 },
    );
  }

  const project = getProject(session.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const effective = getEffectiveProviderConfig(project.id);
  const existingBefore = listFeaturesForProject(project.id).length;

  const transcript = history
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  let generated: z.infer<typeof FeatureListSchema>;
  try {
    const client = new ProviderClient({
      baseUrl: effective.baseUrl,
      model: effective.model,
    });
    generated = await generateStructured({
      client,
      schema: FeatureListSchema,
      name: "feature_backlog",
      messages: [
        { role: "system", content: buildFeatureGenSystemPrompt() },
        { role: "user", content: buildFeatureGenUserPrompt(transcript) },
      ],
      maxTokens: 8192,
      signal: req.signal,
    });
  } catch (err) {
    const detail =
      err instanceof StructuredOutputError
        ? `${err.message} (${err.issues})`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error("[generate-features] structured generation failed:", detail);
    return NextResponse.json(
      { error: `Feature generation failed: ${detail}` },
      { status: 502 },
    );
  }

  // Insert features in order, then resolve depends_on_indexes -> ids.
  // Only backward references are honored (the prompt orders by build
  // sequence), which also makes accidental cycles impossible.
  const createdIds: number[] = [];
  const skippedDeps: string[] = [];
  for (const [index, item] of generated.features.entries()) {
    try {
      const created = createFeature({
        projectId: project.id,
        title: item.title,
        description: item.description,
        acceptanceCriteria: item.acceptance_criteria ?? null,
        category: item.category,
      });
      createdIds.push(created.id);
      for (const depIndex of item.depends_on_indexes) {
        if (depIndex >= index || depIndex < 0 || createdIds[depIndex] == null) {
          skippedDeps.push(`${index}->${depIndex}`);
          continue;
        }
        try {
          addDependency(created.id, createdIds[depIndex]);
        } catch {
          skippedDeps.push(`${index}->${depIndex}`);
        }
      }
    } catch (err) {
      console.error(
        `[generate-features] skipped feature ${index} (${item.title}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const features = listFeaturesForProject(project.id);
  const createdCount = features.length - existingBefore;

  if (createdCount <= 0) {
    return NextResponse.json(
      {
        error:
          "The model returned no usable features. Try again with a clearer description.",
      },
      { status: 502 },
    );
  }

  if (skippedDeps.length > 0) {
    console.warn(
      `[generate-features] skipped ${skippedDeps.length} invalid dependency refs: ${skippedDeps.join(", ")}`,
    );
  }

  closeAgentSession(sessionId, "completed");

  return NextResponse.json({
    count: createdCount,
    total: features.length,
    projectId: project.id,
    summary: `Generated ${createdCount} features from the conversation`,
  });
}
