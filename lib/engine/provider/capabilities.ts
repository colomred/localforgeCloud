import { ProviderRequestError, type ResponseFormat } from "./client";

/**
 * How structured output is requested from a given (baseUrl, model).
 *
 * Providers disagree about `response_format`, and the disagreement is fatal
 * rather than graceful: LM Studio rejects `{"type": "json_object"}` outright
 * with `400 'response_format.type' must be 'json_schema' or 'text'`, while
 * Ollama's OpenAI-compat layer historically understood only `json_object`.
 *
 * We used to settle this with a throwaway probe generation. That cost a full
 * round-trip on a local model and, worse, inferred "unsupported" from output
 * it merely failed to read — a reasoning model answering on the reasoning
 * channel looked exactly like a provider that ignored the parameter, which
 * then routed every request onto a format the provider refused.
 *
 * So: start optimistic at the top of the ladder and step down only when a
 * provider actually rejects a format. The observation is cached per
 * (baseUrl, model) for the process lifetime, so the wasted request happens
 * at most twice per model, not once per pipeline.
 */

export type StructuredMode = "json_schema" | "json_object" | "none";

/** Most constrained first. Downgrades only ever move right. */
const LADDER: StructuredMode[] = ["json_schema", "json_object", "none"];

/** Identity of a provider endpoint — anything with a baseUrl and a model. */
export type ProviderIdentity = { baseUrl: string; model: string };

const cache = new Map<string, StructuredMode>();

function keyOf(client: ProviderIdentity): string {
  return `${client.baseUrl}::${client.model}`;
}

/** The best structured-output mode known to work for this endpoint. */
export function structuredModeFor(client: ProviderIdentity): StructuredMode {
  return cache.get(keyOf(client)) ?? "json_schema";
}

/**
 * Record that `rejected` is unsupported here and return the mode to try next.
 * Returns `rejected` unchanged when the ladder is already exhausted, which is
 * the caller's signal to stop retrying and surface the error.
 */
export function downgradeStructuredMode(
  client: ProviderIdentity,
  rejected: StructuredMode,
): StructuredMode {
  const next = LADDER[LADDER.indexOf(rejected) + 1];
  if (!next) return rejected;
  const current = structuredModeFor(client);
  if (LADDER.indexOf(next) > LADDER.indexOf(current)) {
    cache.set(keyOf(client), next);
  }
  return structuredModeFor(client);
}

/** Did the provider refuse the request because of our `response_format`? */
export function isResponseFormatRejection(err: unknown): boolean {
  if (!(err instanceof ProviderRequestError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /response_format|json_schema|json_object|structured output/i.test(
    err.message,
  );
}

/** The wire value for a mode, or undefined when the mode sends no format. */
export function responseFormatFor(
  mode: StructuredMode,
  schema: { name: string; schema: Record<string, unknown> },
): ResponseFormat | undefined {
  if (mode === "json_schema") {
    return {
      type: "json_schema",
      json_schema: { name: schema.name, strict: true, schema: schema.schema },
    };
  }
  if (mode === "json_object") return { type: "json_object" };
  return undefined;
}

/** Test hook: clear the per-process capability cache. */
export function resetCapabilitiesCache(): void {
  cache.clear();
}
