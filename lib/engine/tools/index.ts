import type { ToolDefinition } from "../provider/client";
import { WorkspaceViolationError } from "./guard";
import { patchTool } from "./patch";
import { readTool } from "./read";
import { runScriptTool } from "./run-script";
import { searchTool } from "./search";
import type { EngineTool, ToolExecutionContext } from "./types";
import { writeFileTool } from "./write-file";

export type { EngineTool, ToolExecutionContext } from "./types";
export { WorkspaceViolationError } from "./guard";

/** The full small-model tool surface: five tools, short schemas. */
export const CODING_TOOLS: EngineTool[] = [
  readTool,
  searchTool,
  writeFileTool,
  patchTool,
  runScriptTool,
];

export function toToolDefinitions(tools: EngineTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function findTool(
  tools: EngineTool[],
  name: string,
): EngineTool | null {
  return tools.find((t) => t.name === name) ?? null;
}

/**
 * Execute a tool call, converting every failure mode into result text the
 * model can read and react to. The loop never throws on tool execution.
 */
export async function executeTool(
  tools: EngineTool[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  const tool = findTool(tools, name);
  if (!tool) {
    const names = tools.map((t) => t.name).join(", ");
    return `error: unknown tool "${name}". Available tools: ${names}, done`;
  }
  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return `error: ${err.message}`;
    }
    return `error: ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
