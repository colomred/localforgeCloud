import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateMessagesTokens,
  estimateTokens,
} from "../../lib/engine/tokens";
import {
  clampToolOutput,
  ContextBudget,
  truncateToTokens,
} from "../../lib/engine/context";

describe("tokens", () => {
  it("estimates roughly chars/3.5 and never rounds down to zero for text", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abc"), 1);
    assert.equal(estimateTokens("a".repeat(350)), 100);
  });

  it("adds per-message overhead", () => {
    const one = estimateMessagesTokens([{ role: "user", content: "hi" }]);
    assert.ok(one >= 4, `expected overhead, got ${one}`);
  });
});

describe("ContextBudget", () => {
  it("hard limit is 80% of the window", () => {
    const budget = new ContextBudget(10_000);
    assert.equal(budget.hardLimit, 8000);
  });

  it("hands off when usage crosses 80% of the hard limit", () => {
    const budget = new ContextBudget(10_000);
    const small = [{ role: "user", content: "hi" }];
    assert.equal(budget.shouldHandOff(small), false);
    // 80% of hardLimit (8000) = 6400 tokens ≈ 22400 chars
    const big = [{ role: "user", content: "x".repeat(23_000) }];
    assert.equal(budget.shouldHandOff(big), true);
  });

  it("generation headroom shrinks as the window fills", () => {
    const budget = new ContextBudget(8192);
    const empty = budget.generationHeadroom([]);
    assert.equal(empty, 4096);
    const nearlyFull = [{ role: "user", content: "x".repeat(27_000) }];
    const headroom = budget.generationHeadroom(nearlyFull);
    assert.ok(headroom < 1000, `expected small headroom, got ${headroom}`);
    assert.ok(headroom >= 256, `expected floor of 256, got ${headroom}`);
  });
});

describe("clampToolOutput", () => {
  it("keeps short output untouched", () => {
    assert.equal(clampToolOutput("hello\nworld"), "hello\nworld");
  });

  it("clamps long output to head + tail with an omission marker", () => {
    const input = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = clampToolOutput(input);
    assert.ok(out.includes("line 0"));
    assert.ok(out.includes("line 499"));
    assert.ok(out.includes("lines omitted"));
    assert.ok(out.split("\n").length < 120);
  });

  it("enforces the byte cap", () => {
    const input = "x".repeat(100_000);
    const out = clampToolOutput(input);
    assert.ok(Buffer.byteLength(out, "utf8") < 10_000);
    assert.ok(out.includes("truncated"));
  });
});

describe("truncateToTokens", () => {
  it("passes short text through and truncates long text", () => {
    assert.equal(truncateToTokens("short", 100), "short");
    const long = "y".repeat(10_000);
    const out = truncateToTokens(long, 100);
    assert.ok(out.length <= 351);
    assert.ok(out.endsWith("…"));
  });
});
