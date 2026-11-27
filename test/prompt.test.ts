import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { extractPromptText, formatPromptContent } from "../server/prompt.js";

function message(content: ProviderContent[]): ProviderPrompt {
  return {
    clientMessageId: "c1",
    delivery: "auto",
    input: { type: "message", content },
  };
}

test("text blocks are kept in order", () => {
  const text = formatPromptContent([
    { type: "text", text: "first" },
    { type: "text", text: "  " },
    { type: "text", text: "second" },
  ]);
  assert.equal(text, "first\n\nsecond");
});

test("image and uploaded file become readable context blocks", () => {
  const text = formatPromptContent([
    { type: "image", data: "base64", mimeType: "image/png" },
    {
      type: "uploaded_file",
      id: "f1",
      fileName: "spec.md",
      mimeType: "text/markdown",
      size: 10,
      path: "/tmp/spec.md",
    },
  ]);
  assert.match(text, /\[Image attachment: image\/png\]/);
  assert.match(text, /\[Attached file: spec\.md \(\/tmp\/spec\.md\)\]/);
});

test("pull requests and issues carry their URL and body", () => {
  const text = formatPromptContent([
    {
      type: "github_pr",
      mimeType: "application/github-pr",
      number: 42,
      title: "Fix it",
      url: "https://github.com/o/r/pull/42",
      body: "details",
      baseRefName: "main",
      headRefName: "fix",
    },
    {
      type: "github_issue",
      mimeType: "application/github-issue",
      number: 7,
      title: "Bug",
      url: "https://github.com/o/r/issues/7",
      body: "repro",
    },
  ]);

  assert.match(text, /Pull request #42: Fix it/);
  assert.match(text, /Base: main/);
  assert.match(text, /Issue #7: Bug/);
});

test("command input becomes a slash command", () => {
  const prompt: ProviderPrompt = {
    clientMessageId: "c2",
    delivery: "auto",
    input: { type: "command", name: "compact", arguments: "" },
  };
  assert.equal(extractPromptText(prompt), "/compact");
});

test("empty content yields an empty string", () => {
  assert.equal(extractPromptText(message([])), "");
});

test("forge change requests and forge issues render like their GitHub variants", () => {
  const text = formatPromptContent([
    {
      type: "forge_change_request",
      mimeType: "application/paseo-forge-change-request",
      number: 9,
      title: "Merge request",
      url: "https://gitlab.example/mr/9",
      body: "body",
    },
    {
      type: "forge_issue",
      mimeType: "application/paseo-forge-issue",
      number: 10,
      title: "Forge issue",
      url: "https://gitlab.example/issues/10",
    },
  ]);

  assert.match(text, /Pull request #9: Merge request/);
  assert.match(text, /Issue #10: Forge issue/);
});

test("review comments list every file and line", () => {
  const review = {
    type: "review",
    mimeType: "application/paseo-review",
    cwd: "/tmp",
    mode: "uncommitted",
    comments: [
      {
        filePath: "src/a.ts",
        side: "new",
        lineNumber: 3,
        body: "nit",
        context: { hunkHeader: "@@", lines: [] },
      },
      {
        filePath: "src/b.ts",
        side: "old",
        lineNumber: 8,
        body: "bug",
        context: { hunkHeader: "@@", lines: [] },
      },
    ],
  } as unknown as ProviderContent;

  const text = formatPromptContent([review]);
  assert.match(text, /src\/a\.ts:3 \(new\): nit/);
  assert.match(text, /src\/b\.ts:8 \(old\): bug/);
});

test("unknown attachment types are ignored", () => {
  const text = formatPromptContent([
    { type: "future_attachment", data: "x" } as unknown as ProviderContent,
    { type: "text", text: "kept" },
  ]);
  assert.equal(text, "kept");
});

test("a whitespace-only prompt extracts to an empty string", () => {
  assert.equal(extractPromptText(message([{ type: "text", text: "  \n\t " }])), "");
});
