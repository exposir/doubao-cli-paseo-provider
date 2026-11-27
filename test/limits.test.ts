import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedText, DEFAULT_LIMITS, resolveLimits, truncateUtf8 } from "../server/limits.js";

test("resolveLimits merges overrides over the defaults", () => {
  const limits = resolveLimits({ maxConcurrentTurns: 1, maxTurnMs: 0 });
  assert.equal(limits.maxConcurrentTurns, 1);
  assert.equal(limits.maxTurnMs, 0);
  assert.equal(limits.maxStderrBytes, DEFAULT_LIMITS.maxStderrBytes);
});

test("resolveLimits rejects negative, NaN and infinite values", () => {
  const limits = resolveLimits({
    maxConcurrentTurns: -1,
    maxTurnMs: Number.NaN,
    maxPromptBytes: Number.POSITIVE_INFINITY,
  });

  assert.equal(limits.maxConcurrentTurns, DEFAULT_LIMITS.maxConcurrentTurns);
  assert.equal(limits.maxTurnMs, DEFAULT_LIMITS.maxTurnMs);
  assert.equal(limits.maxPromptBytes, DEFAULT_LIMITS.maxPromptBytes);
});

test("truncateUtf8 leaves short text alone", () => {
  assert.equal(truncateUtf8("橘猫", 100), "橘猫");
});

test("truncateUtf8 never returns a broken trailing character", () => {
  const cut = truncateUtf8("橘猫", 4);
  assert.equal(cut, "橘");
  assert.ok(!cut.includes("\uFFFD"));
});

test("BoundedText keeps text under the byte ceiling", () => {
  const buffer = new BoundedText(10);
  buffer.append("hello");
  buffer.append(" worl");
  assert.equal(buffer.isTruncated, false);
  assert.equal(buffer.toString(), "hello worl");
});

test("BoundedText adds one marker and ignores later appends", () => {
  const buffer = new BoundedText(5);
  buffer.append("abcdefgh");
  buffer.append("more");
  assert.equal(buffer.toString(), "abcde\n[truncated]");
});

test("BoundedText keeps multi-byte text valid at the cut", () => {
  const buffer = new BoundedText(5);
  buffer.append("你好");
  assert.ok(!buffer.toString().includes("\uFFFD"));
  assert.equal(buffer.toString(), "你\n[truncated]");
});

test("BoundedText with a zero ceiling stores nothing", () => {
  const buffer = new BoundedText(0);
  buffer.append("anything");
  assert.equal(buffer.toString(), "");
  assert.equal(buffer.isTruncated, false);
});
