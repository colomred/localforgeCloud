import { ProviderClient } from "./client";

/**
 * Probe whether the provider honors OpenAI `response_format: json_schema`.
 *
 * LM Studio supports it; Ollama's OpenAI-compat layer historically only
 * supports `json_object`. Rather than keying off provider ids (which rot),
 * we ask the server directly once per (baseUrl, model) and cache the answer
 * for the process lifetime.
 */

export type ProviderCapabilities = {
  jsonSchema: boolean;
};

const cache = new Map<string, ProviderCapabilities>();

const PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

export async function probeCapabilities(
  client: ProviderClient,
): Promise<ProviderCapabilities> {
  const key = `${client.baseUrl}::${client.model}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let jsonSchema = false;
  try {
    const result = await client.chat({
      messages: [
        { role: "user", content: 'Reply with JSON: {"ok": true}' },
      ],
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "probe",
          strict: true,
          schema: PROBE_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      maxTokens: 500,
      temperature: 0,
    });
    const parsed: unknown = JSON.parse(result.content);
    jsonSchema =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { ok?: unknown }).ok === "boolean";
  } catch {
    jsonSchema = false;
  }

  const capabilities: ProviderCapabilities = { jsonSchema };
  cache.set(key, capabilities);
  return capabilities;
}

/** Test hook: clear the per-process capability cache. */
export function resetCapabilitiesCache(): void {
  cache.clear();
}
