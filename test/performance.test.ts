import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStreamEvent, createTurnState } from "../server/stream.js";

const DELTA = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

test("20k deltas are reduced in linear time", () => {
  const state = createTurnState();
  const started = performance.now();

  for (let index = 0; index < 20_000; index += 1) {
    applyStreamEvent(state, DELTA("0123456789abcdef"), { maxTextBytes: 8 * 1024 * 1024 });
  }

  const elapsed = performance.now() - started;
  assert.equal(state.byteLength, 20_000 * 16);
  // Generous bound: this catches quadratic string or byte handling, not CPU model.
  assert.ok(elapsed < 2000, `reducer took ${elapsed.toFixed(1)}ms`);
});

test("the byte cap is maintained incrementally during a long stream", () => {
  const state = createTurnState();
  const started = performance.now();

  for (let index = 0; index < 20_000; index += 1) {
    applyStreamEvent(state, DELTA("0123456789abcdef"), { maxTextBytes: 1024 });
  }

  const elapsed = performance.now() - started;
  assert.equal(state.truncated, true);
  assert.equal(state.byteLength, 1024);
  assert.ok(elapsed < 2000, `capped reducer took ${elapsed.toFixed(1)}ms`);
});
