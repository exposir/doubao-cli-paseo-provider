import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnArgs } from "../server/args.js";

test("a fresh turn asks for streaming JSON and reads the prompt from stdin", () => {
  assert.deepEqual(buildTurnArgs({ cwd: "/root/work" }), [
    "-p",
    "-",
    "--output-format",
    "stream-json",
    "-C",
    "/root/work",
  ]);
});

test("a resumed turn puts --resume before -p -", () => {
  const args = buildTurnArgs({ sessionId: "38456440663565058", cwd: "/w" });
  assert.deepEqual(args, [
    "--resume",
    "38456440663565058",
    "-p",
    "-",
    "--output-format",
    "stream-json",
    "-C",
    "/w",
  ]);
});

test("model, effort and permission mode are forwarded", () => {
  const args = buildTurnArgs({
    model: "person-deepseek-v4-1-flash-261017",
    thinkingOption: "max",
    mode: "always_allow",
  });
  assert.deepEqual(args, [
    "-p",
    "-",
    "--output-format",
    "stream-json",
    "--model",
    "person-deepseek-v4-1-flash-261017",
    "--effort",
    "max",
    "--permission-mode",
    "always_allow",
  ]);
});

test("unset optional fields are omitted entirely", () => {
  const args = buildTurnArgs({ sessionId: null, model: undefined });
  assert.deepEqual(args, ["-p", "-", "--output-format", "stream-json"]);
});
