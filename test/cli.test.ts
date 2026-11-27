import { test } from "node:test";
import assert from "node:assert/strict";
import { lastJsonObject } from "../server/cli.js";

test("lastJsonObject takes the last protocol line, not the first", () => {
  const stdout = [
    '{"type":"system","session_id":"s1"}',
    '{"type":"result","subtype":"success","result":{"type":"text","content":"done"}}',
    "",
  ].join("\n");
  assert.deepEqual(lastJsonObject(stdout), {
    type: "result",
    subtype: "success",
    result: { type: "text", content: "done" },
  });
});

test("lastJsonObject ignores CLI log lines", () => {
  const stdout = [
    '[cli-chat] {"level":"info","eventName":"cli_task_started"}',
    "some human text",
    '{"type":"result","subtype":"success"}',
  ].join("\n");
  assert.deepEqual(lastJsonObject(stdout), { type: "result", subtype: "success" });
});

test("lastJsonObject falls back past a malformed trailing object", () => {
  const stdout = ['{"type":"result","ok":true}', '{"type":"result", broken'].join("\n");
  assert.deepEqual(lastJsonObject(stdout), { type: "result", ok: true });
});

test("lastJsonObject returns null when the output has no JSON", () => {
  assert.equal(lastJsonObject(""), null);
  assert.equal(lastJsonObject("[cli-chat] nothing here\nplain text"), null);
});

test("lastJsonObject ignores JSON arrays", () => {
  assert.equal(lastJsonObject("[1,2,3]"), null);
});
