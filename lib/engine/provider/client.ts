/**
 * Minimal OpenAI-compatible chat client for local providers (LM Studio,
 * Ollama). Non-streaming: the engine runs short, budgeted calls and the UI
 * gets its liveness from pipeline events, not token deltas.
 *
 * Every request path in the engine goes through this client so transient
 * local-server hiccups (model still loading, connection reset) are retried
 * in exactly one place.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
    };

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  responseFormat?: ResponseFormat;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type ChatResult = {
  content: string;
  /** The provider's chain-of-thought channel, when it exposes one. */
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
};

export class ProviderRequestError extends Error {
  readonly status: number | null;
  readonly transient: boolean;
  constructor(message: string, status: number | null, transient: boolean) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = status;
    this.transient = transient;
  }
}

const TRANSIENT_ERROR_PATTERNS = [
  "econnrefused",
  "econnreset",
  "etimedout",
  "socket hang up",
  "fetch failed",
  "timeout",
  "overloaded",
  "rate_limit",
];

function isTransientMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => lower.includes(p));
}

export function ensureV1BaseUrl(baseUrl: string): string {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ProviderClientOptions = {
  baseUrl: string;
  model: string;
  /** Local servers usually ignore the key; sent for OpenAI-compat strictness. */
  apiKey?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Per-request timeout. Local generation on big prompts can be slow. */
  requestTimeoutMs?: number;
};

export class ProviderClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: ProviderClientOptions) {
    this.baseUrl = ensureV1BaseUrl(opts.baseUrl);
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? "localforge";
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 3000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 600_000;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      stream: false,
    };
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    if (request.responseFormat) body.response_format = request.responseFormat;
    if (typeof request.maxTokens === "number") body.max_tokens = request.maxTokens;
    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }

    let lastError: ProviderRequestError | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.chatOnce(body, request.signal);
      } catch (err) {
        if (request.signal?.aborted) throw err;
        const providerError =
          err instanceof ProviderRequestError
            ? err
            : new ProviderRequestError(
                err instanceof Error ? err.message : String(err),
                null,
                isTransientMessage(err instanceof Error ? err.message : String(err)),
              );
        lastError = providerError;
        if (!providerError.transient || attempt === this.maxRetries) {
          throw providerError;
        }
        await sleep(this.retryDelayMs * attempt);
      }
    }
    throw lastError ?? new ProviderRequestError("chat failed", null, false);
  }

  private async chatOnce(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<ChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("provider request timed out")),
      this.requestTimeoutMs,
    );
    const onOuterAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ProviderRequestError(
          `provider returned ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          res.status >= 500 || res.status === 429,
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: ToolCall[];
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      if (!choice?.message) {
        throw new ProviderRequestError(
          "provider response had no choices[0].message",
          null,
          true,
        );
      }
      const toolCalls = Array.isArray(choice.message.tool_calls)
        ? choice.message.tool_calls
        : [];
      const finishReason = choice.finish_reason ?? null;
      const content = choice.message.content ?? "";
      const reasoning =
        choice.message.reasoning_content ?? choice.message.reasoning ?? "";

      // Reasoning models normally split their reply: the answer on `content`,
      // the monologue on `reasoning_content`. Under constrained decoding
      // (response_format json_schema) the grammar applies from the very first
      // token — which for these chat templates is already inside the think
      // block — so the entire, perfectly valid answer arrives on the reasoning
      // channel and `content` comes back empty. Recover it, but only when the
      // model actually stopped: a reply cut off by the token cap leaves half a
      // monologue there, and half a monologue is not an answer.
      const recovered =
        content.trim() === "" && toolCalls.length === 0 && finishReason === "stop"
          ? reasoning
          : content;

      return {
        content: recovered,
        reasoning,
        toolCalls,
        finishReason,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
            }
          : null,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /** Health probe: GET /v1/models. Returns model ids, or throws. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new ProviderRequestError(
        `provider returned ${res.status} for /models`,
        res.status,
        res.status >= 500,
      );
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
  }
}
