import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  copyTemplateDir,
  templateExists,
  templateRootDir,
} from "../../lib/engine/scaffold";

let destDir: string;

beforeEach(() => {
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-scaffold-"));
});

afterEach(() => {
  fs.rmSync(destDir, { recursive: true, force: true });
});

const harnessRoot = path.resolve(import.meta.dirname, "..", "..");

describe("scaffold templates", () => {
  it("both bundled templates exist", () => {
    assert.ok(templateExists("next-app", harnessRoot));
    assert.ok(templateExists("vite-react", harnessRoot));
    assert.ok(!templateExists("none", harnessRoot));
    assert.ok(!templateExists("no-such-template", harnessRoot));
  });

  it("copies next-app with port and name substituted", () => {
    copyTemplateDir(path.join(templateRootDir(harnessRoot), "next-app"), destDir, {
      NAME: "my-app",
      PORT: "3456",
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(destDir, "package.json"), "utf8"));
    assert.equal(pkg.name, "my-app");
    assert.equal(pkg.scripts.dev, "next dev -p 3456");
    const layout = fs.readFileSync(path.join(destDir, "app/layout.tsx"), "utf8");
    assert.ok(layout.includes('title: "my-app"'));
    // gitignore is stored unprefixed in the template, dotted on copy.
    assert.ok(fs.existsSync(path.join(destDir, ".gitignore")));
    assert.ok(!fs.existsSync(path.join(destDir, "gitignore")));
  });

  it("copies vite-react with the port wired into vite.config.ts", () => {
    copyTemplateDir(path.join(templateRootDir(harnessRoot), "vite-react"), destDir, {
      NAME: "vite-app",
      PORT: "3999",
    });
    const config = fs.readFileSync(path.join(destDir, "vite.config.ts"), "utf8");
    assert.ok(config.includes("port: 3999"));
    const html = fs.readFileSync(path.join(destDir, "index.html"), "utf8");
    assert.ok(html.includes("<title>vite-app</title>"));
  });
});
