import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockLlmServer } from "./mocks/mock-llm-server.mjs";

/**
 * End-to-end forge pipeline integration test — fully self-contained.
 *
 * Boots a scripted mock OpenAI-compatible provider, creates a project and a
 * feature through the real API, points the global settings at the mock, and
 * starts the orchestrator. Asserts through the real UI + API that:
 *   - the plan lands as a step checklist on the kanban card (step dots)
 *   - steps pass and the feature completes
 *   - a verification badge is recorded from the forge `verification` meta
 *   - full completion flips the project to the celebration state
 *
 * Requires the LocalForge dev server on BASE_URL (default localhost:7777);
 * everything else (provider, project folder) is created and cleaned up here.
 */

type MockServer = Awaited<ReturnType<typeof startMockLlmServer>>;

const MODEL = "forge-spec-model";

let mock: MockServer;
let workDir: string;
let projectId: number;

test.beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-spec-projects-"));
  mock = await startMockLlmServer({
    scenarios: {
      [MODEL]: [
        {
          json: {
            steps: [
              { title: "Create the greeting module", detail: "Write greet.js exporting a greeting", files: [], verify: "none" },
              { title: "Add an index that uses it", detail: "Write index.js importing greet.js", files: [], verify: "none" },
            ],
          },
        },
        // step 1 session
        { toolCall: { name: "write_file", args: { path: "greet.js", content: "module.exports = () => 'hi';\n" } } },
        { toolCall: { name: "done", args: { summary: "created greet.js" } } },
        // step 2 session
        { toolCall: { name: "write_file", args: { path: "index.js", content: "require('./greet')();\n" } } },
        { toolCall: { name: "done", args: { summary: "created index.js" } } },
        // summarizer
        { text: "# Brief\nStack: plain node\nBuilt so far: greeting module" },
      ],
    },
  });
});

test.afterAll(async () => {
  if (projectId) {
    await fetch(`${baseUrl()}/api/projects/${projectId}`, { method: "DELETE" }).catch(
      () => undefined,
    );
  }
  await mock?.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function baseUrl(): string {
  return process.env.BASE_URL || "http://localhost:7777";
}

async function api(method: string, route: string, body?: unknown) {
  const res = await fetch(`${baseUrl()}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  expect(res.ok, `${method} ${route}: ${JSON.stringify(json)}`).toBeTruthy();
  return json;
}

test.describe("forge pipeline end-to-end", () => {
  test("plans, runs steps, records verification, completes the project", async ({ page }) => {
    test.setTimeout(180_000);

    // Point the harness at the mock provider; keep projects in a temp dir.
    await api("PUT", "/api/settings", {
      provider: "lm_studio",
      lm_studio_url: mock.baseUrl,
      model: MODEL,
      working_directory: workDir,
      project_template: "none",
      max_concurrent_agents: "1",
    });

    const created = await api("POST", "/api/projects", {
      name: `Forge Spec ${Date.now()}`,
    });
    projectId = created.project.id;

    const feature = await api("POST", `/api/projects/${projectId}/features`, {
      title: "Greet the user",
      description: "Provide a greeting module and an entry point that uses it.",
    });
    const featureId: number = feature.feature.id;

    await api("POST", `/api/projects/${projectId}/orchestrator`, {
      action: "start",
    });

    await page.goto(`/projects/${projectId}`);

    // The plan pass populates the step checklist on the kanban card.
    const stepsContainer = page.getByTestId(`feature-card-steps-${featureId}`);
    await expect(stepsContainer).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByTestId(`feature-card-step-${featureId}-0`),
    ).toBeVisible();

    // Both steps eventually pass (the card may leave the board once the
    // project completes, so poll the API rather than the DOM for terminal
    // step state).
    await expect
      .poll(
        async () => {
          const data = await api("GET", `/api/projects/${projectId}/features`);
          const f = data.features.find(
            (x: { id: number }) => x.id === featureId,
          );
          return {
            passed: f?.steps?.passed,
            total: f?.steps?.total,
            status: f?.status,
            badgeOk: f?.testResult?.ok ?? null,
          };
        },
        { timeout: 90_000, intervals: [1000] },
      )
      .toEqual({ passed: 2, total: 2, status: "completed", badgeOk: true });

    // Full completion flips the project page into the celebration state.
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId("celebration-screen")).toBeVisible({
      timeout: 30_000,
    });

    // The brief was written into the project folder by the orchestrator.
    const briefData = await api("GET", `/api/projects/${projectId}/brief`);
    expect(briefData.content).toContain("greeting module");
  });
});
