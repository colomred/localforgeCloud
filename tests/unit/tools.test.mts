import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { patchTool, findAnchor } from "../../lib/engine/tools/patch";
import { readTool } from "../../lib/engine/tools/read";
import { searchTool } from "../../lib/engine/tools/search";
import { writeFileTool } from "../../lib/engine/tools/write-file";
import { parseWhitelistedCommand } from "../../lib/engine/tools/run-script";
import { executeTool, CODING_TOOLS } from "../../lib/engine/tools";

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tools-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

const ctx = () => ({ projectDir });

describe("read tool", () => {
  it("returns numbered windowed lines with paging hints", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join("\n");
    fs.writeFileSync(path.join(projectDir, "big.txt"), lines);
    const out = await readTool.execute({ path: "big.txt", start_line: 100, max_lines: 5 }, ctx());
    assert.ok(out.includes("100| l100"));
    assert.ok(out.includes("104| l104"));
    assert.ok(out.includes("continue with start_line: 105"));
  });

  it("suggests siblings when the file is missing", async () => {
    fs.writeFileSync(path.join(projectDir, "actual.ts"), "x");
    const out = await readTool.execute({ path: "actua.ts" }, ctx());
    assert.ok(out.startsWith("error:"));
    assert.ok(out.includes("actual.ts"));
  });

  it("refuses paths outside the workspace", async () => {
    const out = await executeTool(CODING_TOOLS, "read", { path: "../../etc/passwd" }, ctx());
    assert.ok(out.includes("outside the workspace"));
  });
});

describe("write_file tool", () => {
  it("creates files with parent directories", async () => {
    const out = await writeFileTool.execute(
      { path: "src/deep/new.ts", content: "export {}\n" },
      ctx(),
    );
    assert.ok(out.startsWith("Created"));
    assert.equal(
      fs.readFileSync(path.join(projectDir, "src/deep/new.ts"), "utf8"),
      "export {}\n",
    );
  });

  it("warns when replacing a large file", async () => {
    const big = Array.from({ length: 300 }, () => "line").join("\n");
    fs.writeFileSync(path.join(projectDir, "big.ts"), big);
    const out = await writeFileTool.execute({ path: "big.ts", content: "tiny" }, ctx());
    assert.ok(out.includes("Warning"));
  });
});

describe("patch tool", () => {
  const seed = () =>
    fs.writeFileSync(
      path.join(projectDir, "app.ts"),
      ["function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}"].join("\n"),
    );

  it("replaces an anchored line (whitespace tolerant)", async () => {
    seed();
    const out = await patchTool.execute(
      { path: "app.ts", anchor: "return 1;", content: "  return 42;" },
      ctx(),
    );
    assert.ok(out.startsWith("Replaced"), out);
    const text = fs.readFileSync(path.join(projectDir, "app.ts"), "utf8");
    assert.ok(text.includes("return 42;"));
    assert.ok(!text.includes("return 1;"));
  });

  it("inserts after the anchor with replace_count 0", async () => {
    seed();
    await patchTool.execute(
      { path: "app.ts", anchor: "function a() {", replace_count: 0, content: "  // added" },
      ctx(),
    );
    const lines = fs.readFileSync(path.join(projectDir, "app.ts"), "utf8").split("\n");
    assert.equal(lines[0], "function a() {");
    assert.equal(lines[1], "  // added");
    assert.equal(lines[2], "  return 1;");
  });

  it("reports ambiguity with line numbers and resolves via line hint", async () => {
    fs.writeFileSync(path.join(projectDir, "dup.ts"), ["x = 1;", "y = 2;", "x = 1;"].join("\n"));
    const ambiguous = await patchTool.execute(
      { path: "dup.ts", anchor: "x = 1;", content: "x = 9;" },
      ctx(),
    );
    assert.ok(ambiguous.includes("matches 2 lines"), ambiguous);
    const resolved = await patchTool.execute(
      { path: "dup.ts", anchor: "x = 1;", line: 3, content: "x = 9;" },
      ctx(),
    );
    assert.ok(resolved.startsWith("Replaced"), resolved);
    const lines = fs.readFileSync(path.join(projectDir, "dup.ts"), "utf8").split("\n");
    assert.equal(lines[0], "x = 1;");
    assert.equal(lines[2], "x = 9;");
  });

  it("names near-miss lines when the anchor is missing", async () => {
    seed();
    const out = await patchTool.execute(
      { path: "app.ts", anchor: "function c() {", content: "z" },
      ctx(),
    );
    assert.ok(out.includes("anchor line not found"));
    assert.ok(out.includes("function a() {"), out);
  });

  it("findAnchor prefers the closest match to the line hint", () => {
    const lines = ["a", "dup", "b", "dup", "c"];
    const match = findAnchor(lines, "dup", 4);
    assert.deepEqual(match, { kind: "found", lineIndex: 3 });
  });
});

describe("search tool", () => {
  it("finds content matches with file:line output", async () => {
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "src/a.ts"), "const needle = 1;\n");
    fs.writeFileSync(path.join(projectDir, "src/b.ts"), "const other = 2;\n");
    const out = await searchTool.execute({ query: "needle" }, ctx());
    assert.ok(out.includes("src/a.ts:1"));
    assert.ok(!out.includes("b.ts"));
  });

  it("lists files by glob", async () => {
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "src/a.ts"), "");
    fs.writeFileSync(path.join(projectDir, "readme.md"), "");
    const out = await searchTool.execute({ glob: "*.ts" }, ctx());
    assert.ok(out.includes("src/a.ts"));
    assert.ok(!out.includes("readme.md"));
  });

  it("skips node_modules", async () => {
    fs.mkdirSync(path.join(projectDir, "node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "node_modules/pkg/x.ts"), "needle");
    const out = await searchTool.execute({ query: "needle" }, ctx());
    assert.ok(out.includes("no matches"));
  });
});

describe("run_script whitelist", () => {
  it("allows the sanctioned forms", () => {
    assert.ok(parseWhitelistedCommand("npm run build"));
    assert.ok(parseWhitelistedCommand("npm install zod"));
    assert.ok(parseWhitelistedCommand("npm install"));
    assert.ok(parseWhitelistedCommand("npm test"));
    assert.ok(parseWhitelistedCommand("npx tsc --noEmit"));
    assert.ok(parseWhitelistedCommand("node scripts/seed.js"));
  });

  it("rejects shell syntax and everything else", () => {
    assert.equal(parseWhitelistedCommand("rm -rf /"), null);
    assert.equal(parseWhitelistedCommand("npm run build && rm -rf /"), null);
    assert.equal(parseWhitelistedCommand("npm run build; echo hi"), null);
    assert.equal(parseWhitelistedCommand("node -e 'process.exit()' | cat"), null);
    assert.equal(parseWhitelistedCommand("pkill -f node"), null);
    assert.equal(parseWhitelistedCommand("npx playwright test"), null);
    assert.equal(parseWhitelistedCommand("npm install ../.."), null);
  });
});
