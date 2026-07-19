import fs from "node:fs";
import path from "node:path";
import { resolveInsideWorkspace } from "./guard";
import { intArg, stringArg, type EngineTool } from "./types";

/**
 * Windowed file read. Small models can't afford whole-file dumps, so reads
 * are line-ranged with a hard cap and numbered output (line numbers make
 * `patch` anchors reliable).
 */

const DEFAULT_MAX_LINES = 120;
const HARD_MAX_LINES = 200;

export const readTool: EngineTool = {
  name: "read",
  description:
    "Read part of a file. Returns numbered lines. Use start_line to page through big files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project" },
      start_line: { type: "integer", description: "First line to read (1-based, default 1)" },
      max_lines: { type: "integer", description: `Lines to return (default ${DEFAULT_MAX_LINES}, max ${HARD_MAX_LINES})` },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const rel = stringArg(args, "path");
    if (!rel) return "error: path is required";
    const abs = resolveInsideWorkspace(ctx.projectDir, rel);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      const dir = path.dirname(abs);
      let hint = "";
      try {
        const siblings = fs.readdirSync(dir).slice(0, 20).join(", ");
        hint = ` Files in ${path.relative(ctx.projectDir, dir) || "."}: ${siblings}`;
      } catch {
        hint = ` Directory ${path.relative(ctx.projectDir, dir)} does not exist either.`;
      }
      return `error: ${rel} does not exist.${hint}`;
    }
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(abs).slice(0, 50).join("\n");
      return `${rel} is a directory. Contents:\n${entries}`;
    }

    const content = fs.readFileSync(abs, "utf8");
    const lines = content.split("\n");
    const start = Math.max(1, intArg(args, "start_line") ?? 1);
    const requested = intArg(args, "max_lines") ?? DEFAULT_MAX_LINES;
    const maxLines = Math.min(Math.max(1, requested), HARD_MAX_LINES);
    const end = Math.min(lines.length, start + maxLines - 1);

    if (start > lines.length) {
      return `error: start_line ${start} is past the end of ${rel} (${lines.length} lines)`;
    }

    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(width)}| ${line}`)
      .join("\n");
    const suffix =
      end < lines.length
        ? `\n(showing lines ${start}-${end} of ${lines.length}; continue with start_line: ${end + 1})`
        : `\n(end of file, ${lines.length} lines total)`;
    return body + suffix;
  },
};
