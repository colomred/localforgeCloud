import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { probeCapabilities } from "./provider/capabilities";
import type { ChatMessage, ProviderClient } from "./provider/client";

/**
 * Structured generation: get a zod-validated object out of a small local
 * model, whatever that takes.
 *
 * Strategy ladder:
 *   1. `response_format: json_schema` when the provider honors it
 *      (constrained decoding — malformed output becomes impossible).
 *   2. Otherwise plain prompting with "reply with JSON only", then extract
 *      the first JSON object from the reply and zod-validate it.
 *   3. One repair round-trip: feed the validation error back and ask for a
 *      corrected object.
 */

export class StructuredOutputError extends Error {
  readonly issues: string;
  constructor(message: string, issues: string) {
    super(message);
    this.name = "StructuredOutputError";
    this.issues = issues;
  }
}

/**
 * Extract the first plausible JSON value from free-form model text. Handles
 * markdown fences and prose-wrapped JSON, the two classic small-model sins.
 */
export function extractFirstJson(text: string): unknown {
  const source = String(text ?? "").trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(source);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(source);

  const start = source.search(/[[{]/);
  if (start >= 0) candidates.push(balancedJsonSlice(source, start));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new SyntaxError("no parseable JSON found in model output");
}

/** Slice a balanced {...} or [...] starting at `start`, respecting strings. */
function balancedJsonSlice(text: string, start: number): string {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

export type GenerateStructuredOptions<T> = {
  client: ProviderClient;
  schema: z.ZodType<T>;
  /** Schema name passed to the provider (json_schema mode). */
  name: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>,
): Promise<T> {
  const jsonSchema = zodToJsonSchema(opts.schema, {
    name: opts.name,
    $refStrategy: "none",
  });
  // zodToJsonSchema nests the schema under definitions when named; unwrap.
  const definitions = (jsonSchema as { definitions?: Record<string, unknown> })
    .definitions;
  const schemaObject =
    (definitions?.[opts.name] as Record<string, unknown> | undefined) ??
    (jsonSchema as Record<string, unknown>);

  const capabilities = await probeCapabilities(opts.client);
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.2;

  const attempt = async (messages: ChatMessage[]): Promise<T> => {
    const result = await opts.client.chat({
      messages,
      responseFormat: capabilities.jsonSchema
        ? {
            type: "json_schema",
            json_schema: { name: opts.name, strict: true, schema: schemaObject },
          }
        : { type: "json_object" },
      maxTokens,
      temperature,
      signal: opts.signal,
    });
    const raw = extractFirstJson(result.content);
    const parsed = opts.schema.safeParse(raw);
    if (!parsed.success) {
      throw new StructuredOutputError(
        "model output failed schema validation",
        summariseZodIssues(parsed.error),
      );
    }
    return parsed.data;
  };

  try {
    return await attempt(opts.messages);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const issues =
      err instanceof StructuredOutputError
        ? err.issues
        : err instanceof Error
          ? err.message
          : String(err);
    // One repair round: restate the requirement with the concrete failure.
    const repairMessages: ChatMessage[] = [
      ...opts.messages,
      {
        role: "user",
        content:
          `Your previous reply was not valid. Problems: ${issues}\n` +
          `Reply again with ONLY a JSON object matching this schema (no prose, no markdown):\n` +
          JSON.stringify(schemaObject),
      },
    ];
    return attempt(repairMessages);
  }
}

export function summariseZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
