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

test("CRLF line endings are accepted", () => {
  const parser = new NdjsonParser();
  const events = parser.push('{"type":"system","session_id":"s1"}\r\n{"type":"result","is_error":false}\r\n');
  assert.equal(events.length, 2);
});

test("a multi-byte character split across two buffers is not corrupted", () => {
  const line = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"橘猫"}}}\n';
  const bytes = Buffer.from(line, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("橘", "utf8")) + 1;

  const parser = new NdjsonParser();
  const first = parser.push(bytes.subarray(0, splitAt));
  const second = parser.push(bytes.subarray(splitAt));

  assert.equal(first.length, 0);
  assert.equal(second.length, 1);

  const state = createTurnState();
  applyStreamEvent(state, second[0]);
  assert.equal(state.text, "橘猫");
});

test("non-object JSON lines are ignored by the reducer", () => {
  const state = createTurnState();
  assert.equal(applyStreamEvent(state, 42), "none");
  assert.equal(applyStreamEvent(state, "text"), "none");
  assert.equal(applyStreamEvent(state, []), "none");
  assert.equal(state.text, "");
});

test("the first session id wins when later events repeat it", () => {
  const state = createTurnState();
  applyStreamEvent(state, { type: "system", session_id: "first" });
  applyStreamEvent(state, { type: "result", session_id: "second", is_error: false });
  assert.equal(state.sessionId, "first");
});

test("non-text deltas leave the answer untouched", () => {
  const state = createTurnState();
  applyStreamEvent(state, {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
  });
  assert.equal(state.text, "");
});

test("assistant messages concatenate every text block and skip non-text blocks", () => {
  const state = createTurnState();
  applyStreamEvent(state, {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "first " },
        { type: "tool_use", id: "t1", name: "bash" },
        { type: "text", text: "second" },
      ],
    },
  });
  assert.equal(state.text, "first second");
});

test("an empty assistant message does not erase streamed text", () => {
  const state = createTurnState();
  applyStreamEvent(state, {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "kept" } },
  });
  applyStreamEvent(state, { type: "assistant", message: { content: [] } });
  assert.equal(state.text, "kept");
});

test("a result without text still completes the turn", () => {
  const state = createTurnState();
  const effect = applyStreamEvent(state, { type: "result", subtype: "success", is_error: false });
  assert.equal(effect, "done");
  assert.equal(state.done, true);
  assert.equal(state.text, "");
});

test("streamed text stops at the byte cap and is marked", () => {
  const state = createTurnState();
  applyStreamEvent(
    state,
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "abcdefghij" } },
    },
    { maxTextBytes: 5 },
  );

  assert.equal(state.truncated, true);
  assert.match(state.text, /\[output truncated\]/);
  assert.ok(Buffer.byteLength(state.text) < 40);
});

test("the assistant message is truncated on a UTF-8 boundary", () => {
  const state = createTurnState();
  applyStreamEvent(
    state,
    { type: "assistant", message: { content: [{ type: "text", text: "橘猫橘猫" }] } },
    { maxTextBytes: 4 },
  );

  assert.equal(state.truncated, true);
  assert.ok(state.text.startsWith("橘"));
  assert.ok(!state.text.includes("\uFFFD"));
});

test("the result payload is bounded as well", () => {
  const state = createTurnState();
  applyStreamEvent(
    state,
    { type: "result", is_error: false, result: { type: "text", content: "x".repeat(100) } },
    { maxTextBytes: 10 },
  );

  assert.equal(state.truncated, true);
  assert.ok(state.finalText && Buffer.byteLength(state.finalText) < 60);
});

test("text exactly at the cap is not marked as truncated", () => {
  const state = createTurnState();
  applyStreamEvent(
    state,
    { type: "assistant", message: { content: [{ type: "text", text: "12345" }] } },
    { maxTextBytes: 5 },
  );

  assert.equal(state.truncated, false);
  assert.equal(state.text, "12345");
});
