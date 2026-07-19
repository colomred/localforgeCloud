import fs from "node:fs";
import { resolveInsideWorkspace } from "./guard";
import { intArg, stringArg, type EngineTool } from "./types";

/**
 * Line-anchored tolerant edit — the small-model replacement for exact-match
 * string editing (the classic failure mode: the model reproduces the target
 * text with one wrong space and the edit bounces forever).
 *
 * The model anchors on ONE line it saw in a numbered `read`, optionally
 * disambiguated by line number. Matching is whitespace-tolerant; failure
 * messages name near misses so the model can self-correct in one turn.
 */

export type AnchorMatch =
  | { kind: "found"; lineIndex: number }
  | { kind: "not_found"; nearMisses: string[] }
  | { kind: "ambiguous"; lineNumbers: number[] };

export function findAnchor(
  lines: string[],
  anchor: string,
  nearLine: number | null,
): AnchorMatch {
  const target = anchor.trim();
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target) matches.push(i);
  }

  if (matches.length === 1) return { kind: "found", lineIndex: matches[0] };
  if (matches.length > 1) {
    if (nearLine !== null) {
      // Pick the match closest to the hinted line number.
      let best = matches[0];
      for (const m of matches) {
        if (Math.abs(m + 1 - nearLine) < Math.abs(best + 1 - nearLine)) best = m;
      }
      return { kind: "found", lineIndex: best };
    }
    return { kind: "ambiguous", lineNumbers: matches.map((m) => m + 1) };
  }

  // No exact trimmed match: report closest candidates (same leading token).
  const lead = target.split(/\s+/)[0] ?? "";
  const nearMisses: string[] = [];
  if (lead.length >= 2) {
    for (let i = 0; i < lines.length && nearMisses.length < 3; i++) {
      if (lines[i].trim().startsWith(lead)) {
        nearMisses.push(`${i + 1}| ${lines[i].trim().slice(0, 120)}`);
      }
    }
  }
  return { kind: "not_found", nearMisses };
}

export const patchTool: EngineTool = {
  name: "patch",
  description:
    "Edit a file at a specific line. Find the line matching `anchor` (copy it from read output, without the line number), replace that line and the next replace_count-1 lines with `content`. Use replace_count 0 to insert after the anchor without replacing.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project" },
      anchor: { type: "string", description: "Existing line to anchor on (text only, no line number)" },
      line: { type: "integer", description: "Line number hint when the anchor text appears more than once" },
      replace_count: { type: "integer", description: "How many lines to replace starting at the anchor (default 1; 0 = insert after)" },
      content: { type: "string", description: "Replacement (or inserted) lines" },
    },
    required: ["path", "anchor", "content"],
  },
  async execute(args, ctx) {
    const rel = stringArg(args, "path");
    const anchor = stringArg(args, "anchor");
    const content = typeof args.content === "string" ? args.content : null;
    if (!rel) return "error: path is required";
    if (!anchor) return "error: anchor is required (an existing line from the file)";
    if (content === null) return "error: content is required (a string)";

    const abs = resolveInsideWorkspace(ctx.projectDir, rel);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return `error: ${rel} does not exist. Use write_file to create new files.`;
    }

    const lines = text.split("\n");
    const match = findAnchor(lines, anchor, intArg(args, "line"));

    if (match.kind === "not_found") {
      const hint =
        match.nearMisses.length > 0
          ? ` Similar lines:\n${match.nearMisses.join("\n")}`
          : " Read the file first and copy the anchor line exactly.";
      return `error: anchor line not found in ${rel}.${hint}`;
    }
    if (match.kind === "ambiguous") {
      return (
        `error: anchor matches ${match.lineNumbers.length} lines in ${rel} ` +
        `(lines ${match.lineNumbers.join(", ")}). Add "line" with the intended line number.`
      );
    }

    const replaceCount = Math.max(0, intArg(args, "replace_count") ?? 1);
    const insertLines = content.split("\n");
    const before =
      replaceCount === 0
        ? lines.slice(0, match.lineIndex + 1)
        : lines.slice(0, match.lineIndex);
    const after =
      replaceCount === 0
        ? lines.slice(match.lineIndex + 1)
        : lines.slice(match.lineIndex + replaceCount);

    const nextLines = [...before, ...insertLines, ...after];

    fs.writeFileSync(abs, nextLines.join("\n"), "utf8");

    const at = match.lineIndex + 1;
    return replaceCount === 0
      ? `Inserted ${insertLines.length} line(s) after line ${at} in ${rel}`
      : `Replaced ${replaceCount} line(s) at line ${at} in ${rel} with ${insertLines.length} line(s)`;
  },
};
