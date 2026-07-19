import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runPipeline, type PipelineJob } from "../../lib/engine/pipeline";
import type { RunnerEvent } from "../../lib/engine/events";
import { resetCapabilitiesCache } from "../../lib/engine/provider/capabilities";
import { startMockLlmServer } from "../mocks/mock-llm-server.mjs";

type MockServer = Awaited<ReturnType<typeof startMockLlmServer>>;
let server: MockServer | null = null;
let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pipeline-"));
  // A minimal existing project: package.json present (skips scaffold), no
  // tsconfig (skips typecheck), no dev/build scripts (skips build + smoke).
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "test-app", version: "1.0.0" }),
  );
});

afterEach(async () => {
  resetCapabilitiesCache();
  fs.rmSync(projectDir, { recursive: true, force: true });
  if (server) {
    await server.close();
    server = null;
  }
});

function makeJob(overrides: Partial<PipelineJob> = {}): PipelineJob {
  return {
    sessionId: 1,
    feature: {
      id: 42,
      title: "Add a greeting",
      description: "Show a greeting on the page",
      acceptanceCriteria: null,
    },
    projectDir,
    projectName: "test-app",
    provider: "lm_studio",
    baseUrl: server!.baseUrl,
    model: "m",
    devServerPort: "3123",
    template: "none",
    coderPrompt: "",
    contextWindowFallback: 8192,
    specGeneration: false,
    harnessRoot: process.cwd(),
    screenshotPath: null,
    screenshotRelPath: null,
    existingSteps: [],
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("plans, runs steps, and succeeds end-to-end", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { json: { ok: true } }, // capabilities probe
          {
            json: {
              steps: [
                { title: "Create greeting module", detail: "Add greet.js", files: [], verify: "none" },
                { title: "Wire it up", detail: "Use greet.js", files: ["greet.js"], verify: "none" },
              ],
            },
          },
          // step 1 session
          { toolCall: { name: "write_file", args: { path: "greet.js", content: "module.exports = () => 'hi';" } } },
          { toolCall: { name: "done", args: { summary: "created greet.js" } } },
          // step 2 session
          { toolCall: { name: "patch", args: { path: "greet.js", anchor: "module.exports = () => 'hi';", content: "module.exports = () => 'hello';" } } },
          { toolCall: { name: "done", args: { summary: "updated greeting" } } },
          // summarizer
          { text: "# Brief\nStack: node\nBuilt so far: greeting" },
        ],
      },
    });

    const events: RunnerEvent[] = [];
    const result = await runPipeline(makeJob(), (e) => events.push(e), new AbortController().signal);

    assert.equal(result.outcome, "success");
    const plan = events.find((e) => e.type === "plan");
    assert.ok(plan && plan.type === "plan" && plan.steps.length === 2);
    const stepEvents = events.filter((e) => e.type === "step");
    assert.ok(stepEvents.some((e) => e.type === "step" && e.stepIndex === 0 && e.status === "passed"));
    assert.ok(stepEvents.some((e) => e.type === "step" && e.stepIndex === 1 && e.status === "passed"));
    const brief = events.find((e) => e.type === "brief");
    assert.ok(brief && brief.type === "brief" && brief.content.includes("greeting"));
    assert.equal(
      fs.readFileSync(path.join(projectDir, "greet.js"), "utf8"),
      "module.exports = () => 'hello';",
    );
  });

  it("fails the feature with a note when a step session errors out", async () => {
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { json: { ok: true } }, // capabilities probe
          { json: { steps: [{ title: "Broken step", detail: "x", files: [], verify: "none" }] } },
          // step session: three malformed replies in a row
          { toolCall: { name: "write_file", args: "{bad json" } },
          { toolCall: { name: "write_file", args: "{bad json" } },
          { text: "" },
        ],
      },
    });

    const events: RunnerEvent[] = [];
    const result = await runPipeline(makeJob(), (e) => events.push(e), new AbortController().signal);

    assert.equal(result.outcome, "failure");
    assert.equal(result.failedStepIndex, 0);
    const failed = events.find((e) => e.type === "step" && e.status === "failed");
    assert.ok(failed);
    const note = events.find((e) => e.type === "note");
    assert.ok(note && note.type === "note" && note.content.includes("step 1"));
  });

  it("resumes at the first non-passed step with an existing plan", async () => {
    // Resume never calls generateStructured, so there is no capabilities
    // probe: the first request is already the step-2 session.
    server = await startMockLlmServer({
      scenarios: {
        m: [
          { toolCall: { name: "write_file", args: { path: "b.js", content: "b" } } },
          { toolCall: { name: "done", args: { summary: "did step 2" } } },
          { text: "updated brief" },
        ],
      },
    });

    const events: RunnerEvent[] = [];
    const result = await runPipeline(
      makeJob({
        existingSteps: [
          { index: 0, title: "Step one", detail: "already done", status: "passed" },
          { index: 1, title: "Step two", detail: "todo", status: "planned" },
        ],
      }),
      (e) => events.push(e),
      new AbortController().signal,
    );

    assert.equal(result.outcome, "success");
    // Step 0 must be re-announced as passed without a session.
    assert.ok(
      events.some((e) => e.type === "step" && e.stepIndex === 0 && e.status === "passed"),
    );
    assert.ok(fs.existsSync(path.join(projectDir, "b.js")));
    // No plan call was made: requests = step session x2 + summarizer.
    assert.equal(server.requests.length, 3);
  });
});
