import { test } from "node:test";
import assert from "node:assert/strict";
import { DoubaoError, errorPayload, summarizeStderr } from "../server/errors.js";

test("summarizeStderr drops CLI log noise", () => {
  const stderr = [
    '[cli-chat] {"level":"info","eventName":"im_request_started"}',
    "invalid_arguments: --model 参数非法",
    "",
  ].join("\n");
  assert.equal(summarizeStderr(stderr), "invalid_arguments: --model 参数非法");
});

test("summarizeStderr truncates very long output", () => {
  const summary = summarizeStderr("x".repeat(30), 10);
  assert.equal(summary, `${"x".repeat(10)}...`);
});

test("errorPayload keeps a provider error code", () => {
  assert.deepEqual(errorPayload(new DoubaoError("busy", "TURN_ACTIVE")), {
    message: "busy",
    code: "TURN_ACTIVE",
  });
  assert.deepEqual(errorPayload(new Error("boom")), {
    message: "boom",
    code: "DOUBAO_ERROR",
  });
});

test("summarizeStderr returns an empty string when only logs remain", () => {
  assert.equal(summarizeStderr('[cli-chat] {"level":"info"}\n\n  \n'), "");
});

test("summarizeStderr does not truncate output at exactly the limit", () => {
  assert.equal(summarizeStderr("x".repeat(10), 10), "x".repeat(10));
});

test("errorPayload handles thrown strings and unknown values", () => {
  assert.deepEqual(errorPayload("plain failure"), {
    message: "plain failure",
    code: "DOUBAO_ERROR",
  });
  assert.deepEqual(errorPayload({ nope: true }), {
    message: "[object Object]",
    code: "DOUBAO_ERROR",
  });
});

test("DoubaoError defaults to the generic code", () => {
  const error = new DoubaoError("nope");
  assert.equal(error.code, "DOUBAO_ERROR");
  assert.equal(error.name, "DoubaoError");
});
