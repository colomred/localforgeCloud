import {
  estimateMessagesTokens,
  estimateTokens,
  type CountableMessage,
} from "./tokens";

/**
 * Context budgeting for a single model session.
 *
 * The budget is derived from the *real* context window of the loaded model
 * (detected from the provider, or the user's context_window setting as a
 * fallback) rather than an optimistic hardcoded number. Two thresholds:
 *
 *   hardLimit  = window * 0.8      — space the conversation may occupy;
 *                                    the remaining 20% is generation
 *                                    headroom and estimator error margin.
 *   handoff at = hardLimit * 0.8   — when the conversation crosses this,
 *                                    the session should extract a progress
 *                                    note and respawn rather than limp on.
 */

const HARD_LIMIT_FACTOR = 0.8;
const HANDOFF_FACTOR = 0.8;

/** Tool-output clamp defaults: head+tail keeps both the command echo and the error tail. */
const CLAMP_HEAD_LINES = 60;
const CLAMP_TAIL_LINES = 40;
const CLAMP_MAX_BYTES = 8 * 1024;

export type BudgetSnapshot = {
  usedTokens: number;
  limitTokens: number;
};

export class ContextBudget {
  readonly contextWindow: number;
  readonly hardLimit: number;

  constructor(contextWindow: number) {
    this.contextWindow = contextWindow;
    this.hardLimit = Math.floor(contextWindow * HARD_LIMIT_FACTOR);
  }

  usage(messages: CountableMessage[]): BudgetSnapshot {
    return {
      usedTokens: estimateMessagesTokens(messages),
      limitTokens: this.hardLimit,
    };
  }

  shouldHandOff(messages: CountableMessage[]): boolean {
    return (
      estimateMessagesTokens(messages) >
      Math.floor(this.hardLimit * HANDOFF_FACTOR)
    );
  }

  /**
   * Max tokens the model may generate right now: whatever fits between the
   * current conversation size and the real window, capped at `cap`.
   */
  generationHeadroom(messages: CountableMessage[], cap = 4096): number {
    const used = estimateMessagesTokens(messages);
    const free = this.contextWindow - used;
    return Math.max(256, Math.min(cap, free));
  }
}

/**
 * Clamp a tool output to head+tail lines and a byte cap so a single noisy
 * command (npm install, build logs, a huge file) can't flood the context.
 */
export function clampToolOutput(
  text: string,
  opts: { headLines?: number; tailLines?: number; maxBytes?: number } = {},
): string {
  const headLines = opts.headLines ?? CLAMP_HEAD_LINES;
  const tailLines = opts.tailLines ?? CLAMP_TAIL_LINES;
  const maxBytes = opts.maxBytes ?? CLAMP_MAX_BYTES;

  let out = text ?? "";
  const lines = out.split("\n");
  if (lines.length > headLines + tailLines + 1) {
    const omitted = lines.length - headLines - tailLines;
    out = [
      ...lines.slice(0, headLines),
      `… [${omitted} lines omitted] …`,
      ...lines.slice(lines.length - tailLines),
    ].join("\n");
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    // Byte cap after line clamp: keep the head half and tail quarter.
    const headBytes = Math.floor(maxBytes / 2);
    const tailBytes = Math.floor(maxBytes / 4);
    const buf = Buffer.from(out, "utf8");
    out =
      buf.subarray(0, headBytes).toString("utf8") +
      `\n… [output truncated to ${maxBytes} bytes] …\n` +
      buf.subarray(buf.length - tailBytes).toString("utf8");
  }
  return out;
}

/** Rough sanity helper for prompt sizing: truncate text to a token estimate. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = Math.floor(maxTokens * 3.5);
  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}
