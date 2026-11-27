import { test } from "node:test";
import assert from "node:assert/strict";
import { NdjsonParser, applyStreamEvent, createTurnState } from "../server/stream.js";

test("NdjsonParser reassembles a line split across chunks", () => {
  const parser = new NdjsonParser();
  assert.deepEqual(parser.push('{"type":"sys'), []);
  const events = parser.push('tem","session_id":"abc"}\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "system", session_id: "abc" });
});

test("NdjsonParser parses multiple events and ignores log lines", () => {
  const parser = new NdjsonParser();
  const events = parser.push(
    [
      '[cli-chat] {"level":"info","eventName":"im_request_started"}',
      '{"type":"assistant","session_id":"s1","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"hi"}}',
      "",
    ].join("\n"),
  );
  assert.equal(events.length, 2);
});

test("NdjsonParser flushes a trailing event without newline", () => {
  const parser = new NdjsonParser();
  parser.push('{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"tail"}}');
  const events = parser.end();
  assert.equal(events.length, 1);
});

test("stream deltas accumulate and are superseded by the assistant message", () => {
  const state = createTurnState();

  applyStreamEvent(state, { type: "system", subtype: "init", session_id: "s1" });
  assert.equal(state.sessionId, "s1");

  applyStreamEvent(state, {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
  });
  assert.equal(state.text, "OK");

  applyStreamEvent(state, {
    type: "assistant",
    message: { content: [{ type: "text", text: "OK, done" }] },
  });
  assert.equal(state.text, "OK, done");
});

test("result event records final text and completes the turn", () => {
  const state = createTurnState();
  const effect = applyStreamEvent(state, {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s1",
    result: { type: "text", content: "final answer" },
  });

  assert.equal(effect, "done");
  assert.equal(state.done, true);
  assert.equal(state.finalText, "final answer");
  assert.equal(state.text, "final answer");
});

test("result with is_error reports the error", () => {
  const state = createTurnState();
  const effect = applyStreamEvent(state, {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    result: { type: "text", content: "too many turns" },
  });

  assert.equal(effect, "error");
  assert.equal(state.error, "too many turns");
  assert.equal(state.done, true);
});

test("unknown events keep the learned session id", () => {
  const state = createTurnState();
  applyStreamEvent(state, { type: "system", session_id: "s1" });
  assert.equal(applyStreamEvent(state, { type: "mystery" }), "session");
  assert.equal(state.sessionId, "s1");
});
