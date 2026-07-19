/**
 * Detect the real context window of the loaded model.
 *
 * The old runner hardcoded 128k regardless of reality; people run small
 * models at 8-32k locally, and budgeting against a fictional window is how
 * sessions quietly degrade. Detection strategy:
 *
 *   - LM Studio exposes a beta REST API (GET /api/v0/models) that reports
 *     `loaded_context_length` (what the model is actually loaded with) and
 *     `max_context_length`.
 *   - Ollama reports the model's maximum via POST /api/show
 *     (`model_info["<arch>.context_length"]`) — not the loaded num_ctx, but
 *     still a better ceiling than a hardcoded constant.
 *   - Anything else (or any failure) falls back to the user's
 *     context_window setting, which is authoritative when detection can't be.
 */

export type ProviderKind = "lm_studio" | "ollama";

export type ContextWindowResult = {
  tokens: number;
  source: "lm_studio" | "ollama" | "fallback";
};

/** Strip a trailing /v1 so we can hit provider-native (non-OpenAI) routes. */
function providerRootUrl(baseUrl: string): string {
  return String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
}

async function detectLmStudio(
  baseUrl: string,
  model: string,
): Promise<number | null> {
  const root = providerRootUrl(baseUrl);
  const res = await fetch(`${root}/api/v0/models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    data?: Array<{
      id?: string;
      loaded_context_length?: number;
      max_context_length?: number;
    }>;
  };
  const models = data.data ?? [];
  const entry =
    models.find((m) => m.id === model) ??
    // LM Studio ids sometimes differ in case or registry prefix.
    models.find((m) => m.id?.toLowerCase() === model.toLowerCase());
  if (!entry) return null;
  const tokens = entry.loaded_context_length ?? entry.max_context_length;
  return typeof tokens === "number" && tokens >= 1024 ? tokens : null;
}

async function detectOllama(
  baseUrl: string,
  model: string,
): Promise<number | null> {
  const root = providerRootUrl(baseUrl);
  const res = await fetch(`${root}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    model_info?: Record<string, unknown>;
  };
  const info = data.model_info ?? {};
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value >= 1024 ? value : null;
    }
  }
  return null;
}

export async function detectContextWindow(opts: {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  fallbackTokens: number;
}): Promise<ContextWindowResult> {
  try {
    if (opts.provider === "lm_studio") {
      const tokens = await detectLmStudio(opts.baseUrl, opts.model);
      if (tokens) return { tokens, source: "lm_studio" };
    } else if (opts.provider === "ollama") {
      const tokens = await detectOllama(opts.baseUrl, opts.model);
      if (tokens) return { tokens, source: "ollama" };
    }
  } catch {
    // Detection is best-effort; the fallback below is always valid.
  }
  return { tokens: opts.fallbackTokens, source: "fallback" };
}
