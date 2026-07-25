import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  downgradeStructuredMode,
  isResponseFormatRejection,
  responseFormatFor,
  structuredModeFor,
} from "./provider/capabilities";
import type { ChatMessage, ProviderClient } from "./provider/client";

/**
 * Structured generation: get a zod-validated object out of a small local
 * model, whatever that takes.
 *
 * Strategy ladder:
 *   1. `response_format: json_schema` — constrained decoding, which makes
 *      malformed output impossible. Every provider we target is asked for
 *      this first.
 *   2. `response_format: json_object` for providers that reject json_schema,
 *      and plain prompting for providers that reject both. Neither carries
 *      the shape, so the schema goes into the prompt instead.
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
  // Input typed as unknown so schemas with .default() infer their OUTPUT
  // type for T (input and output diverge on defaulted fields).
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
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

  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.2;

  // Constrained decoding carries the shape on its own. Without it the model
  // has to be told which keys to produce, or "reply with JSON only" yields
  // well-formed JSON of entirely the wrong shape.
  const withSchemaInPrompt = (messages: ChatMessage[]): ChatMessage[] => [
    ...messages,
    {
      role: "user",
      content:
        `Reply with ONLY a JSON object matching this schema ` +
        `(no prose, no markdown):\n${JSON.stringify(schemaObject)}`,
    },
  ];

  /** Request one completion, stepping down the ladder if the format is refused. */
  const chat = async (messages: ChatMessage[]) => {
    for (;;) {
      const mode = structuredModeFor(opts.client);
      try {
        return await opts.client.chat({
          messages: mode === "json_schema" ? messages : withSchemaInPrompt(messages),
          responseFormat: responseFormatFor(mode, {
            name: opts.name,
            schema: schemaObject,
          }),
          maxTokens,
          temperature,
          signal: opts.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted || !isResponseFormatRejection(err)) throw err;
        if (downgradeStructuredMode(opts.client, mode) === mode) throw err;
      }
    }
  };

  const attempt = async (messages: ChatMessage[]): Promise<T> => {
    const result = await chat(messages);
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
