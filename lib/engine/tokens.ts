/**
 * Approximate token accounting.
 *
 * The engine never has access to the exact tokenizer of whatever model the
 * user loaded, so it uses a deliberately conservative character-ratio
 * estimate. English prose runs ~4 chars/token and code a bit lower; using
 * 3.5 overestimates usage slightly, which is the safe direction — budgets
 * trip early rather than blowing the real context window.
 */

const CHARS_PER_TOKEN = 3.5;

/** Fixed per-message overhead (role, separators) in tokens. */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type CountableMessage = {
  role: string;
  content: string | null;
  /** Serialized tool calls also occupy context. */
  toolCallsJson?: string;
};

export function estimateMessageTokens(message: CountableMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  if (message.content) total += estimateTokens(message.content);
  if (message.toolCallsJson) total += estimateTokens(message.toolCallsJson);
  return total;
}

export function estimateMessagesTokens(messages: CountableMessage[]): number {
  return messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}
