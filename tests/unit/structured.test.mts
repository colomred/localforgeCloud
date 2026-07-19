import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { ProviderClient } from "../../lib/engine/provider/client";
import { detectContextWindow } from "../../lib/engine/provider/context-window";
import { resetCapabilitiesCache } from "../../lib/engine/provider/capabilities";
import {
  extractFirstJson,
  generateStructured,
} from "../../lib/engine/structured";
import { startMockLlmServer } from "../mocks/mock-llm-server.mjs";

type MockServer = Awaited<ReturnType<typeof startMockLlmServer>>;
let server: MockServer | null = null;

afterEach(async () => {
  resetCapabilitiesCache();
  if (server) {
    await server.close();
    server = null;
  }
});

describe("extractFirstJson", () => {
  it("parses bare JSON", () => {
    assert.deepEqual(extractFirstJson('{"a": 1}'), { a: 1 });
  });

  it("parses fenced JSON", () => {
    assert.deepEqual(extractFirstJson('```json\n{"a": 1}\n```'), { a: 1 });
  });

  it("parses prose-wrapped JSON", () => {
    assert.deepEqual(
      extractFirstJson('Sure! Here is the plan: {"steps": ["x"]} Hope that helps.'),
      { steps: ["x"] },
    );
  });

  it("handles nested braces inside strings", () => {
    assert.deepEqual(extractFirstJson('prefix {"code": "if (a) { b() }"} suffix'), {
      code: "if (a) { b() }",
    });
  });

  it("throws when there is no JSON", () => {
    assert.throws(() => extractFirstJson("no json here"));
  });
});

describe("generateStructured", () => {
  const schema = z.object({
    steps: z.array(z.object({ title: z.string() })).min(1),
  });

  it("returns a validated object from a json_schema-capable provider", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { json: { ok: true } }, // capabilities probe
          { json: { steps: [{ title: "step one" }] } },
        ],
      },
    });
    const client = new ProviderClient({ baseUrl: server.baseUrl, model: "m" });
    const result = await generateStructured({
      client,
      schema,
      name: "plan",
      messages: [{ role: "user", content: "plan it" }],
    });
    assert.equal(result.steps[0].title, "step one");
  });

  it("repairs after an invalid first reply", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { text: "not json at all" }, // capabilities probe fails -> json_object mode
          { json: { steps: [] } }, // fails min(1)
          { json: { steps: [{ title: "fixed" }] } }, // repair round
        ],
      },
    });
    const client = new ProviderClient({ baseUrl: server.baseUrl, model: "m" });
    const result = await generateStructured({
      client,
      schema,
      name: "plan",
      messages: [{ role: "user", content: "plan it" }],
    });
    assert.equal(result.steps[0].title, "fixed");
    // The repair request should include the schema and the failure.
    const lastRequest = server.requests.at(-1) as {
      messages: Array<{ content: string }>;
    };
    const lastMessage = lastRequest.messages.at(-1)!;
    assert.ok(lastMessage.content.includes("not valid"));
  });
});

describe("detectContextWindow", () => {
  it("reads loaded_context_length from the LM Studio beta API", async () => {
    server = await startMockLlmServer({
      scenarios: { m: [] },
      contextLength: 16384,
    });
    const result = await detectContextWindow({
      provider: "lm_studio",
      baseUrl: `${server.baseUrl}/v1`,
      model: "m",
      fallbackTokens: 8192,
    });
    assert.deepEqual(result, { tokens: 16384, source: "lm_studio" });
  });

  it("falls back to the setting when detection fails", async () => {
    const result = await detectContextWindow({
      provider: "lm_studio",
      baseUrl: "http://127.0.0.1:1", // nothing listening
      model: "m",
      fallbackTokens: 8192,
    });
    assert.deepEqual(result, { tokens: 8192, source: "fallback" });
  });
});
