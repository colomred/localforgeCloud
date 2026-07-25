import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ContextBudget } from "../../lib/engine/context";
import { runLoop, type LoopEvent } from "../../lib/engine/loop";
import { resetCapabilitiesCache } from "../../lib/engine/provider/capabilities";
import { ProviderClient } from "../../lib/engine/provider/client";
import { CODING_TOOLS } from "../../lib/engine/tools";
import { startMockLlmServer } from "../mocks/mock-llm-server.mjs";

type MockServer = Awaited<ReturnType<typeof startMockLlmServer>>;
let server: MockServer | null = null;
let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-loop-"));
});

afterEach(async () => {
  resetCapabilitiesCache();
  fs.rmSync(projectDir, { recursive: true, force: true });
  if (server) {
    await server.close();
    server = null;
  }
});

function loopOptions(model: string, overrides: Record<string, unknown> = {}) {
  return {
    client: new ProviderClient({ baseUrl: server!.baseUrl, model }),
    budget: new ContextBudget(32_000),
    tools: CODING_TOOLS,
    toolCtx: { projectDir },
    systemPrompt: "You are a coding agent.",
    userPrompt: "Do the thing.",
    maxTurns: 10,
    ...overrides,
  };
}

describe("runLoop", () => {
  it("happy path: native tool calls, then done", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { toolCall: { name: "write_file", args: { path: "a.txt", content: "hi" } } },
          { toolCall: { name: "done", args: { summary: "wrote a.txt" } } },
        ],
      },
    });
    const events: LoopEvent[] = [];
    const result = await runLoop(
      loopOptions("m", { onEvent: (e: LoopEvent) => events.push(e) }),
    );
    assert.equal(result.outcome, "done");
    assert.equal(result.summary, "wrote a.txt");
    assert.equal(result.toolCalls, 1);
    assert.equal(fs.readFileSync(path.join(projectDir, "a.txt"), "utf8"), "hi");
    assert.ok(events.some((e) => e.type === "tool_start"));
  });

  it("treats plain text without a tool call as completion", async () => {
    server = await startMockLlmServer({
      scenarios: { m: [{ text: "All finished, the feature works." }] },
    });
    const result = await runLoop(loopOptions("m"));
    assert.equal(result.outcome, "done");
    assert.equal(result.summary, "All finished, the feature works.");
  });

  it("accepts a JSON envelope pasted as plain text", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { json: { tool: "write_file", args: { path: "b.txt", content: "x" } } },
          { toolCall: { name: "done", args: { summary: "ok" } } },
        ],
      },
    });
    const result = await runLoop(loopOptions("m"));
    assert.equal(result.outcome, "done");
    assert.ok(fs.existsSync(path.join(projectDir, "b.txt")));
  });

  it("flips to envelope mode after repeated malformed tool calls", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { toolCall: { name: "write_file", args: "{not json" } },
          { toolCall: { name: "write_file", args: "{still not json" } },
          // After two malformed calls the loop switches to envelope mode
          // (tools are no longer sent; the envelope schema is).
          { json: { tool: "write_file", args: { path: "c.txt", content: "y" } } },
          { json: { tool: "done", args: { summary: "recovered" } } },
        ],
      },
    });
    const result = await runLoop(loopOptions("m"));
    assert.equal(result.outcome, "done");
    assert.equal(result.summary, "recovered");
    assert.ok(fs.existsSync(path.join(projectDir, "c.txt")));
    const envelopeRequest = server.requests.at(-1) as {
      tools?: unknown;
      response_format?: { type: string; json_schema?: { name: string } };
    };
    assert.equal(envelopeRequest.tools, undefined);
    assert.equal(envelopeRequest.response_format?.type, "json_schema");
    assert.equal(envelopeRequest.response_format?.json_schema?.name, "tool_envelope");
  });

  it("falls back to json_object in envelope mode when json_schema is refused", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { toolCall: { name: "write_file", args: "{not json" } },
          { toolCall: { name: "write_file", args: "{still not json" } },
          // Envelope mode asks for json_schema; this provider only knows
          // json_object, so the turn is retried rather than lost.
          { status: 400, error: "'response_format.type' must be 'json_object'" },
          { json: { tool: "done", args: { summary: "recovered" } } },
        ],
      },
    });
    const result = await runLoop(loopOptions("m"));
    assert.equal(result.outcome, "done");
    assert.equal(result.summary, "recovered");
    const envelopeRequest = server.requests.at(-1) as Record<string, unknown>;
    assert.deepEqual(envelopeRequest.response_format, { type: "json_object" });
  });

  it("gives up after three consecutive malformed replies", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { toolCall: { name: "x", args: "{bad" } },
          { toolCall: { name: "x", args: "{bad" } },
          { text: "" },
        ],
      },
    });
    const result = await runLoop(loopOptions("m"));
    assert.equal(result.outcome, "malformed");
  });

  it("stops with budget outcome when the conversation outgrows the window", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          // Big tool result each turn fills the tiny budget quickly.
          { toolCall: { name: "read", args: { path: "big.txt" } } },
          { toolCall: { name: "read", args: { path: "big.txt" } } },
          { toolCall: { name: "read", args: { path: "big.txt" } } },
          { toolCall: { name: "read", args: { path: "big.txt" } } },
        ],
      },
    });
    fs.writeFileSync(
      path.join(projectDir, "big.txt"),
      Array.from({ length: 90 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n"),
    );
    const result = await runLoop(
      loopOptions("m", { budget: new ContextBudget(2048), maxTurns: 20 }),
    );
    assert.equal(result.outcome, "budget");
  });

  it("enforces the turn cap", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [{ toolCall: { name: "search", args: { glob: "*.ts" } } }],
      },
    });
    const result = await runLoop(loopOptions("m", { maxTurns: 3 }));
    assert.equal(result.outcome, "max_turns");
    assert.equal(result.turns, 3);
  });

  it("reports unknown tools back to the model instead of crashing", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { toolCall: { name: "bash", args: { command: "ls" } } },
          { toolCall: { name: "done", args: { summary: "ok" } } },
        ],
      },
    });
    const events: LoopEvent[] = [];
    const result = await runLoop(
      loopOptions("m", { onEvent: (e: LoopEvent) => events.push(e) }),
    );
    assert.equal(result.outcome, "done");
    const toolResult = events.find((e) => e.type === "tool_result");
    assert.ok(
      toolResult && "output" in toolResult && toolResult.output.includes("unknown tool"),
    );
  });
});
