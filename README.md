# LocalForge

> Build apps on autopilot with local AI models. No cloud, no API keys, no per-token billing.

## Quick Start

### 1. Prerequisites

- **Node.js 20+** — [download here](https://nodejs.org/)
- **LM Studio** — [download here](https://lmstudio.ai/)

### 2. Set up LM Studio

1. Open LM Studio and download a model (e.g. `google/gemma-4-31b`)
2. Load the model and start the local API server (default: `http://127.0.0.1:1234`)

### 3. Install and run LocalForge

```bash
git clone https://github.com/leonvanzyl/localforge.git
cd localforge
npm install
npm run db:migrate
npm run dev
```

Open **http://localhost:7777** in your browser.

### 4. Build something

1. Create a new project from the sidebar
2. Describe your app — the AI bootstrapper generates features automatically
3. Click **Start** and watch agents build it feature by feature

---

## What is LocalForge?

LocalForge lets you describe an app in plain language and watch AI coding agents
build it on your own hardware. Point it at a model running in LM Studio, click
Start, and the orchestrator breaks your idea into features, tracks them on a
kanban board, and deploys agents to implement and test them one at a time.

## How the orchestrator works

1. You create a project, either manually or by chatting with the AI bootstrapper.
   New project folders are scaffolded from a template by the harness itself
   (dev-server port pre-wired, dependencies installed) — zero model turns.
2. Features land in the **Backlog** column of the kanban, ordered by priority
   and respecting dependencies.
3. Click **Start** — LocalForge picks the highest-priority ready feature, moves
   the card to **In Progress**, and runs it through the forge pipeline: a
   planning call decomposes the feature into 3–8 small steps, and each step runs
   in a **fresh, token-budgeted micro-session** sized to the model's real
   context window.
4. After each step the **harness** verifies the work (type-check; then build +
   a browser smoke test at the end) — the model never certifies its own output
   and never drives a browser. Failures get focused fix sessions with just the
   parsed errors.
5. Step progress, pipeline phases, verification results and context-meter
   readings stream live into the kanban cards and agent pods via SSE.
6. On success the card moves to **Completed** and the project brief
   (`.localforge/brief.md`) is updated so the next agent doesn't re-explore the
   codebase. On failure the feature returns to the backlog with demoted
   priority and a failure note — the retry resumes at the first unfinished
   step instead of starting over.
7. When all features pass, confetti.

## Why it works with small models

Small local models fail in predictable ways: their context fills with tool
output and they quietly degrade, they flub exact-match edits, and they emit
malformed tool calls. The forge engine is built around those limits — honest
context-window detection (LM Studio/Ollama) with hard token budgets and
handoff to a fresh session before degradation, clamped tool outputs, five
small tools with tolerant line-anchored editing, automatic fallback to a
JSON-envelope tool protocol, and persistent file-based memory
(`.localforge/brief.md` + per-feature notes) so no session wastes its window
rediscovering the project.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server on port 7777 |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run db:generate` | Generate a Drizzle migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm test` | Run Playwright tests |

## Tech stack

- **Frontend:** Next.js 16 (App Router) + React 19, Tailwind CSS + shadcn/ui, dnd-kit, Sonner
- **Backend:** Next.js API routes (Node.js), SQLite + Drizzle ORM, Server-Sent Events
- **Agents:** LocalForge's own forge engine (bespoke agent loop over the
  OpenAI-compatible API) for LM Studio/Ollama
- **Testing:** Playwright (harness integration tests) + node:test (engine unit tests)

## Project layout

```
app/                 Next.js App Router routes + API handlers
  api/               REST API endpoints
components/          React components
  ui/                shadcn/ui primitives
lib/
  db/                Drizzle schema + SQLite connection
  engine/            The forge engine: agent loop, tools, context budgeting,
                     pipeline, verification, memory, scaffolding
  agent/             Orchestrator (slots, watchdogs, SSE fan-out) + provider glue
templates/           Project scaffolding templates (next-app, vite-react)
scripts/             engine-runner.ts (the per-feature child process) + dev helpers
data/                SQLite database file (git-ignored)
projects/            User-created project folders (git-ignored)
drizzle/             Generated migrations
tests/               Playwright specs + engine unit tests (tests/unit)
```

## Configuration

Configure globally via **Settings** in the sidebar, or per project via project
settings. The keys that matter most for small models:

- **Context window** — fallback token count when the real loaded context can't
  be detected from LM Studio/Ollama. Match it to what you configured in your
  model server; the engine budgets every session against it.
- **Project template** — `next-app`, `vite-react`, or `none`. New projects are
  scaffolded deterministically by the harness.
- **Spec generation** (off by default) — after a feature passes, the model
  *writes* a Playwright spec and the harness executes it; results show as a
  badge on the kanban card but never fail the feature. The model never drives
  a browser interactively.

Each project keeps its agent memory in `.localforge/` (`brief.md` and
per-feature notes) — plain markdown you can read and edit.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
