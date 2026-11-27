import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolItem, extractToolEvents, type ToolCall } from "../server/tools.js";

const bashCall: ToolCall = {
  kind: "call",
  callId: "t1",
  name: "Bash",
  input: { command: "echo hi", cwd: "/tmp" },
};

test("assistant tool_use blocks become calls", () => {
  const events = extractToolEvents({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/tmp/a" } },
      ],
    },
  });

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: "call",
    callId: "t1",
    name: "Bash",
    input: { command: "echo hi" },
  });
});

test("user tool_result blocks become results", () => {
  const events = extractToolEvents({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: false,
          content: [{ type: "text", text: "ok" }, { type: "text", text: "done" }],
        },
      ],
    },
  });

  assert.deepEqual(events, [
    { kind: "result", callId: "t1", isError: false, output: "ok\ndone" },
  ]);
});

test("a shell call keeps command, cwd, output and exit code", () => {
  const running = buildToolItem(bashCall);
  assert.equal(running.status, "running");
  assert.equal(running.detail.type, "shell");

  const done = buildToolItem(bashCall, {
    kind: "result",
    callId: "t1",
    isError: false,
    output: "Command 'echo hi' exited with code 0. stdout: hi",
  });

  assert.equal(done.status, "completed");
  assert.equal(done.error, null);
  if (done.detail.type === "shell") {
    assert.equal(done.detail.command, "echo hi");
    assert.equal(done.detail.cwd, "/tmp");
    assert.equal(done.detail.exitCode, 0);
    assert.match(done.detail.output ?? "", /stdout: hi/);
  }
});

test("a failed result marks the call failed", () => {
  const item = buildToolItem(bashCall, {
    kind: "result",
    callId: "t1",
    isError: true,
    output: "permission denied",
  });

  assert.equal(item.status, "failed");
  assert.deepEqual(item.error, { message: "permission denied" });
});

test("read, edit, search and unknown tools map to typed details", () => {
  const read = buildToolItem({
    kind: "call",
    callId: "r",
    name: "Read",
    input: { file_path: "/tmp/a.txt" },
  });
  assert.equal(read.detail.type, "read");
  if (read.detail.type === "read") assert.equal(read.detail.filePath, "/tmp/a.txt");

  const edit = buildToolItem(
    { kind: "call", callId: "e", name: "Edit", input: { file_path: "/tmp/a", old_string: "a", new_string: "b" } },
    { kind: "result", callId: "e", isError: false, output: "@@ -1 +1 @@" },
  );
  assert.equal(edit.detail.type, "edit");
  if (edit.detail.type === "edit") {
    assert.equal(edit.detail.oldString, "a");
    assert.equal(edit.detail.unifiedDiff, "@@ -1 +1 @@");
  }

  const search = buildToolItem({
    kind: "call",
    callId: "s",
    name: "Grep",
    input: { pattern: "TODO" },
  });
  assert.equal(search.detail.type, "search");
  if (search.detail.type === "search") {
    assert.equal(search.detail.query, "TODO");
    assert.equal(search.detail.toolName, "grep");
  }

  const unknown = buildToolItem({
    kind: "call",
    callId: "u",
    name: "Mystery",
    input: { x: 1 },
  });
  assert.equal(unknown.detail.type, "unknown");
});
