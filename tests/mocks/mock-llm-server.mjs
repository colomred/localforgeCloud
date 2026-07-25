/**
 * Mock OpenAI-compatible provider for tests.
 *
 * Implements the three endpoints the engine touches:
 *   POST /v1/chat/completions   — scripted responses
 *   GET  /v1/models             — health probe
 *   GET  /api/v0/models         — LM Studio context-window detection
 *
 * Scenarios are keyed by the request's `model` field: each scenario is an
 * array of canned responses consumed in order (the last one repeats). A
 * response can be:
 *   { text: "..." }                              — plain assistant text
 *   { toolCall: { name, args } }                 — native tool_calls reply
 *   { json: {...} }                              — JSON body as text (for
 *                                                  structured/envelope mode)
 *   { reasoning: {...} | "..." }                 — reply delivered on the
 *                                                  reasoning channel with an
 *                                                  empty content, as reasoning
 *                                                  models do under constrained
 *                                                  decoding
 *   { status, error }                            — HTTP error instead of a
 *                                                  completion (e.g. a provider
 *                                                  refusing a response_format)
 *   { fn: (body) => response }                   — computed per request
 *
 * Used programmatically by unit tests (startMockLlmServer) and standalone
 * for Playwright integration runs (node tests/mocks/mock-llm-server.mjs).
 */

import http from "node:http";

let callIdCounter = 0;

function toOpenAiResponse(resolved, body) {
  const message = { role: "assistant", content: null };
  if (resolved.toolCall) {
    message.tool_calls = [
      {
        id: `call_${++callIdCounter}`,
        type: "function",
        function: {
          name: resolved.toolCall.name,
          arguments:
            typeof resolved.toolCall.args === "string"
              ? resolved.toolCall.args
              : JSON.stringify(resolved.toolCall.args ?? {}),
        },
      },
    ];
  } else if (resolved.json !== undefined) {
    message.content =
      typeof resolved.json === "string"
        ? resolved.json
        : JSON.stringify(resolved.json);
  } else if (resolved.reasoning !== undefined) {
    message.content = "";
    message.reasoning_content =
      typeof resolved.reasoning === "string"
        ? resolved.reasoning
        : JSON.stringify(resolved.reasoning);
  } else {
    message.content = resolved.text ?? "";
  }
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

export function startMockLlmServer(options = {}) {
  const scenarios = new Map(Object.entries(options.scenarios ?? {}));
  const cursors = new Map();
  const requests = [];
  const contextLength = options.contextLength ?? 8192;

  const server = http.createServer((req, res) => {
    let bodyText = "";
    req.on("data", (chunk) => (bodyText += chunk));
    req.on("end", () => {
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "GET" && req.url === "/v1/models") {
        return send(200, {
          data: [...scenarios.keys()].map((id) => ({ id, object: "model" })),
        });
      }
      if (req.method === "GET" && req.url === "/api/v0/models") {
        return send(200, {
          data: [...scenarios.keys()].map((id) => ({
            id,
            loaded_context_length: contextLength,
            max_context_length: contextLength * 2,
          })),
        });
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return send(400, { error: "bad json" });
        }
        requests.push(body);
        const scenario = scenarios.get(body.model);
        if (!scenario || scenario.length === 0) {
          return send(404, { error: `no scenario for model ${body.model}` });
        }
        const cursor = cursors.get(body.model) ?? 0;
        const scripted = scenario[Math.min(cursor, scenario.length - 1)];
        cursors.set(body.model, cursor + 1);
        const resolved =
          typeof scripted === "function" ? scripted(body) : scripted;
        if (resolved.status && resolved.status >= 400) {
          return send(resolved.status, { error: resolved.error ?? "error" });
        }
        return send(200, toOpenAiResponse(resolved, body));
      }
      send(404, { error: `unhandled ${req.method} ${req.url}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        setScenario(model, responses) {
          scenarios.set(model, responses);
          cursors.set(model, 0);
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Standalone mode for Playwright integration tests: fixed port + a default
// scripted scenario driven by fixture file when provided.
const isMain = process.argv[1] && process.argv[1].endsWith("mock-llm-server.mjs");
if (isMain) {
  (async () => {
    const port = Number.parseInt(process.env.MOCK_LLM_PORT ?? "1234", 10);
    const fixturePath = process.env.MOCK_LLM_FIXTURE;
    const scenarios = {};
    if (fixturePath) {
      const { readFileSync } = await import("node:fs");
      Object.assign(scenarios, JSON.parse(readFileSync(fixturePath, "utf8")));
    }
    const handle = await startMockLlmServer({ port, scenarios });
    console.log(`mock LLM server listening on ${handle.baseUrl}`);
  })();
}
