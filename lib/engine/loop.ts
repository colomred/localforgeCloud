import { clampToolOutput, ContextBudget, type BudgetSnapshot } from "./context";
import type {
  ChatMessage,
  ProviderClient,
  ToolCall,
} from "./provider/client";
import { extractFirstJson } from "./structured";
import {
  executeTool,
  toToolDefinitions,
  type EngineTool,
  type ToolExecutionContext,
} from "./tools";

/**
 * The bespoke agent loop — the replacement for pi-coding-agent, built for
 * small local models. Design goals:
 *
 *   - Total control of every token entering the window (clamped tool
 *     outputs, budget checks before each request, hard turn caps).
 *   - Tolerance for flaky tool calling: native OpenAI `tool_calls` first;
 *     after repeated malformed calls the loop flips to a JSON-envelope
 *     protocol ({"tool": ..., "args": ...} as the entire reply), which weak
 *     models produce far more reliably than the tool_calls wire format.
 *   - Clean terminal states the pipeline can act on: done / turn cap /
 *     budget handoff / malformed / aborted / error.
 */

export type LoopOutcome =
  | "done"
  | "max_turns"
  | "budget"
  | "malformed"
  | "aborted"
  | "error";

export type LoopEvent =
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string }
  | { type: "assistant_text"; text: string }
  | { type: "malformed"; detail: string }
  | { type: "budget"; snapshot: BudgetSnapshot };

export type LoopOptions = {
  client: ProviderClient;
  budget: ContextBudget;
  tools: EngineTool[];
  toolCtx: ToolExecutionContext;
  systemPrompt: string;
  userPrompt: string;
  maxTurns: number;
  temperature?: number;
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void;
};

export type LoopResult = {
  outcome: LoopOutcome;
  /** Summary passed to `done`, or the final plain-text reply. */
  summary: string;
  turns: number;
  toolCalls: number;
  error?: string;
  /** Full transcript — used for progress-note extraction on handoff. */
  messages: ChatMessage[];
  budget: BudgetSnapshot;
};

/** Consecutive malformed tool calls before flipping to envelope mode. */
const ENVELOPE_MODE_THRESHOLD = 2;
/** Consecutive malformed calls (in any mode) before giving up. */
const MALFORMED_GIVE_UP = 3;

const DONE_TOOL_NAME = "done";

const DONE_TOOL: EngineTool = {
  name: DONE_TOOL_NAME,
  description: "Call when the task is complete. Nothing runs after this.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One or two sentences on what you did" },
    },
    required: ["summary"],
  },
  // Never executed — the loop intercepts it.
  execute: async () => "",
};

const ENVELOPE_INSTRUCTION =
  `Tool calling format change: reply with ONLY a JSON object, no prose, shaped ` +
  `{"tool": "<name>", "args": {...}}. One tool per reply. ` +
  `Example: {"tool": "read", "args": {"path": "package.json"}}. ` +
  `When finished: {"tool": "done", "args": {"summary": "..."}}`;

type ParsedCall = { name: string; args: Record<string, unknown> };

function parseNativeToolCall(call: ToolCall): ParsedCall | null {
  const name = call.function?.name;
  if (!name) return null;
  const rawArgs = call.function.arguments ?? "{}";
  try {
    const args: unknown = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return null;
    }
    return { name, args: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Parse an envelope-mode reply (or an envelope pasted into plain text). */
function parseEnvelope(text: string): ParsedCall | null {
  try {
    const parsed = extractFirstJson(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as { tool?: unknown; args?: unknown };
    if (typeof obj.tool !== "string") return null;
    const args =
      typeof obj.args === "object" && obj.args !== null && !Array.isArray(obj.args)
        ? (obj.args as Record<string, unknown>)
        : {};
    return { name: obj.tool, args };
  } catch {
    return null;
  }
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const allTools = [...opts.tools, DONE_TOOL];
  const toolDefs = toToolDefinitions(allTools);

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userPrompt },
  ];

  let turns = 0;
  let toolCallCount = 0;
  let consecutiveMalformed = 0;
  let totalMalformed = 0;
  let envelopeMode = false;
  let lastAssistantText = "";

  const snapshot = () => opts.budget.usage(countable(messages));

  const finish = (
    outcome: LoopOutcome,
    summary: string,
    error?: string,
  ): LoopResult => ({
    outcome,
    summary,
    turns,
    toolCalls: toolCallCount,
    error,
    messages,
    budget: snapshot(),
  });

  while (turns < opts.maxTurns) {
    if (opts.signal?.aborted) return finish("aborted", lastAssistantText);
    if (opts.budget.shouldHandOff(countable(messages))) {
      const snap = snapshot();
      opts.onEvent?.({ type: "budget", snapshot: snap });
      return finish("budget", lastAssistantText);
    }

    turns++;

    let content: string;
    let toolCalls: ToolCall[];
    try {
      const result = await opts.client.chat({
        messages,
        tools: envelopeMode ? undefined : toolDefs,
        responseFormat: envelopeMode ? { type: "json_object" } : undefined,
        maxTokens: opts.budget.generationHeadroom(countable(messages)),
        temperature: opts.temperature ?? 0.2,
        signal: opts.signal,
      });
      content = result.content;
      toolCalls = result.toolCalls;
    } catch (err) {
      if (opts.signal?.aborted) return finish("aborted", lastAssistantText);
      return finish(
        "error",
        lastAssistantText,
        err instanceof Error ? err.message : String(err),
      );
    }

    opts.onEvent?.({ type: "budget", snapshot: snapshot() });

    // Resolve this turn's tool call, from whichever format the model used.
    let call: ParsedCall | null = null;
    let malformedDetail: string | null = null;

    if (!envelopeMode && toolCalls.length > 0) {
      call = parseNativeToolCall(toolCalls[0]);
      if (!call) {
        malformedDetail = `unparseable tool_calls arguments for "${toolCalls[0]?.function?.name ?? "?"}"`;
      }
    } else if (content.trim()) {
      const envelope = parseEnvelope(content);
      if (envelope) {
        call = envelope;
      } else if (envelopeMode) {
        malformedDetail = "reply was not a {\"tool\", \"args\"} JSON object";
      } else {
        // Plain text with no tool call in native mode = the model is done
        // talking. Treat as completion; small models often skip `done`.
        lastAssistantText = content.trim();
        opts.onEvent?.({ type: "assistant_text", text: lastAssistantText });
        messages.push({ role: "assistant", content });
        return finish("done", lastAssistantText);
      }
    } else {
      malformedDetail = "empty reply (no text, no tool call)";
    }

    if (!call) {
      consecutiveMalformed++;
      totalMalformed++;
      opts.onEvent?.({
        type: "malformed",
        detail: malformedDetail ?? "unknown",
      });
      if (consecutiveMalformed >= MALFORMED_GIVE_UP) {
        return finish(
          "malformed",
          lastAssistantText,
          `gave up after ${consecutiveMalformed} consecutive malformed tool calls (${malformedDetail})`,
        );
      }
      if (!envelopeMode && totalMalformed >= ENVELOPE_MODE_THRESHOLD) {
        envelopeMode = true;
        messages.push({ role: "user", content: ENVELOPE_INSTRUCTION });
      } else {
        messages.push({
          role: "user",
          content: `Your last reply was malformed (${malformedDetail}). ${
            envelopeMode
              ? ENVELOPE_INSTRUCTION
              : "Call exactly one tool, or reply with a short completion summary."
          }`,
        });
      }
      continue;
    }

    consecutiveMalformed = 0;

    if (call.name === DONE_TOOL_NAME) {
      const summary =
        typeof call.args.summary === "string" && call.args.summary
          ? call.args.summary
          : lastAssistantText || "done";
      messages.push({ role: "assistant", content: `[done] ${summary}` });
      opts.onEvent?.({ type: "assistant_text", text: summary });
      return finish("done", summary);
    }

    toolCallCount++;
    opts.onEvent?.({ type: "tool_start", name: call.name, args: call.args });

    const output = await executeTool(allTools, call.name, call.args, opts.toolCtx);
    const clamped = clampToolOutput(output);
    opts.onEvent?.({ type: "tool_result", name: call.name, output: clamped });

    // Record the exchange. In envelope mode the "call" is plain content, and
    // the result comes back as a user message — no tool_call_id plumbing for
    // the model to trip over.
    if (envelopeMode) {
      messages.push({
        role: "assistant",
        content: JSON.stringify({ tool: call.name, args: call.args }),
      });
      messages.push({
        role: "user",
        content: `Result of ${call.name}:\n${clamped}`,
      });
    } else {
      messages.push({
        role: "assistant",
        content: content || null,
        tool_calls: [
          {
            id: toolCalls[0]?.id ?? `call_${turns}`,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        content: clamped,
        tool_call_id: toolCalls[0]?.id ?? `call_${turns}`,
      });
    }
  }

  return finish("max_turns", lastAssistantText, `turn cap (${opts.maxTurns}) reached`);
}

function countable(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCallsJson: m.tool_calls ? JSON.stringify(m.tool_calls) : undefined,
  }));
}
