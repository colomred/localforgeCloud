import fs from "node:fs";
import path from "node:path";
import { resolveInsideWorkspace } from "./guard";
import { stringArg, type EngineTool } from "./types";

/**
 * Whole-file write. The primary tool for NEW files; for existing files the
 * prompts steer the model toward `patch` so a partial hallucinated rewrite
 * can't silently destroy content (a rewrite of a large existing file gets a
 * warning back so the model can double-check itself).
 */

const LARGE_REWRITE_LINES = 200;

export const writeFileTool: EngineTool = {
  name: "write_file",
  description:
    "Create or fully replace a file with the given content. Best for new or small files; use patch for edits to big files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project" },
      content: { type: "string", description: "Complete file content" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const rel = stringArg(args, "path");
    const content = typeof args.content === "string" ? args.content : null;
    if (!rel) return "error: path is required";
    if (content === null) return "error: content is required (a string)";

    const abs = resolveInsideWorkspace(ctx.projectDir, rel);

    let previousLines: number | null = null;
    try {
      previousLines = fs.readFileSync(abs, "utf8").split("\n").length;
    } catch {
      previousLines = null;
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");

    const newLines = content.split("\n").length;
    if (previousLines !== null && previousLines > LARGE_REWRITE_LINES) {
      return (
        `Replaced ${rel} (${previousLines} lines -> ${newLines} lines). ` +
        `Warning: that file was large — verify nothing important was dropped, or prefer patch next time.`
      );
    }
    return previousLines === null
      ? `Created ${rel} (${newLines} lines)`
      : `Replaced ${rel} (${newLines} lines)`;
  },
};
