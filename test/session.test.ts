import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderCatalog,
  ProviderEvent,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { fallbackCatalog, MODES } from "../server/catalog.js";
import type { Limits } from "../server/limits.js";
import { Session } from "../server/session.js";

interface FakeCli {
  command: string;
  dir: string;
}

function fakeCli(body: string): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "doubao-fake-"));
  const command = join(dir, "doubao");
  writeFileSync(command, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/args.log"\n${body}\n`);
  chmodSync(command, 0o755);
  return { command, dir };
}

function prompt(text = "hi"): ProviderPrompt {
  return {
    clientMessageId: "msg-1",
    delivery: "auto",
    input: { type: "message", content: [{ type: "text", text }] },
  };
}

function createSession(
  cli: FakeCli,
  cwd: string,
  events: ProviderEvent[],
  options: {
    catalog?: ProviderCatalog;
    config?: Partial<ProviderSessionConfig>;
    limits?: Partial<Limits>;
    persistence?: ProviderPersistence;
  } = {},
): Session {
  return new Session({
    id: "session-1",
    config: {
      cwd,
      env: {},
      mcpServers: {},
      settings: {},
      persist: false,
      ...options.config,
    },
    launch: { command: cli.command, args: [], env: {} },
    catalog: () => options.catalog ?? fallbackCatalog(),
    limits: options.limits,
    persistence: options.persistence,
    emit: (event) => events.push(event),
  });
}

const CATALOG: ProviderCatalog = {
  models: [
    {
      id: "m1",
      label: "Model One",
      isDefault: true,
      thinkingOptions: [
        { id: "low", label: "low" },
        { id: "max", label: "max", isDefault: true },
      ],
      defaultThinkingOptionId: "max",
    },
    { id: "m2", label: "Model Two" },
  ],
  modes: MODES,
  thinkingOptions: [
    { id: "low", label: "low" },
    { id: "max", label: "max" },
  ],
  defaultModel: "m1",
  defaultMode: "ask_risky",
  defaultThinkingOption: "max",
};

function assistantText(events: ProviderEvent[]): string {
  return events
    .filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")
    .map((event) => (event.type === "timeline.item" && event.item.type === "assistant_message" ? event.item.text : ""))
    .join("");
}

const HAPPY = [
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'`,
  `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"OK!"}]}}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":{"type":"text","content":"OK!"}}'`,
].join("\n");

test("a happy turn emits user, turn, text, persistence and completion", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  assert.ok(events.some((event) => event.type === "timeline.item" && event.item.type === "user_message"));
  assert.ok(
    events.some(
      (event) => event.type === "session.prompt_result" && event.result.type === "turn",
    ),
  );
  assert.ok(
    events.some((event) => event.type === "session.turn" && event.state === "completed"),
  );

  const persistence = events.find((event) => event.type === "session.persistence");
  assert.ok(persistence && persistence.type === "session.persistence");
  assert.equal((persistence.persistence.data as { doubaoSessionId: string }).doubaoSessionId, "sess-1");
  assert.equal(assistantText(events), "OK!");
});

test("the second turn is spawned with --resume and the native session id", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt("first"));
  await session.prompt(prompt("second"));

  const calls = readFileSync(join(cli.dir, "args.log"), "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0], /--resume/);
  assert.match(calls[1], /--resume sess-1/);
});

test("a non-zero exit becomes a failed turn with the stderr text", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `echo "boom: bad arguments" >&2`,
      `exit 3`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "EXIT_3");
  assert.match(failed.error?.message ?? "", /boom: bad arguments/);

  const cleared = events
    .filter((event) => event.type === "session.persistence")
    .at(-1);
  assert.ok(cleared && cleared.type === "session.persistence");
  assert.deepEqual(cleared.persistence.data, { doubaoSessionId: null });
});

test("a result event with is_error fails the turn even when the process exits 0", async () => {
  const cli = fakeCli(
    `printf '%s\\n' '{"type":"result","subtype":"error_max_turns","is_error":true,"result":{"type":"text","content":"quota exceeded"}}'`,
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "DOUBAO_RESULT_ERROR");
  assert.equal(failed.error?.message, "quota exceeded");
});

test("a silent success produces a readable placeholder instead of an empty message", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":""}}'`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  assert.match(assistantText(events), /Task completed with no textual output/);
  assert.ok(
    events.some((event) => event.type === "session.turn" && event.state === "completed"),
  );
});

test("an empty prompt is rejected before spawning anything", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await assert.rejects(session.prompt(prompt("   ")), /Prompt is empty/);
  assert.equal(existsSync(join(cli.dir, "args.log")), false);
});

test("a second prompt while one is running is rejected", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  const running = session.prompt(prompt("long"));
  await new Promise((resolve) => setTimeout(resolve, 200));

  await assert.rejects(session.prompt(prompt("second")), /already running/);

  await session.interrupt();
  await running;

  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "canceled"));
});

test("interrupt cancels the turn and keeps the session usable", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  const running = session.prompt(prompt());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(session.canStopRuntime(), false);

  await session.interrupt();
  await running;

  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "canceled"));
  assert.equal(session.canStopRuntime(), true);
});

test("closing an idle session does not emit another turn", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);
  const before = events.length;

  await session.close();
  assert.equal(events.length, before);
  await assert.rejects(session.prompt(prompt()), /Session is closed/);
});

test("open publishes the catalogue defaults and the per-model thinking options", () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { catalog: CATALOG });

  session.open("open-1", ["prompt.message", "session.configure"]);

  const opened = events.find((event) => event.type === "session.opened");
  assert.ok(opened && opened.type === "session.opened");
  assert.equal(opened.cwd, cli.dir);
  assert.equal(opened.restoration, "core");

  const config = events.find((event) => event.type === "session.config");
  assert.ok(config && config.type === "session.config");
  assert.equal(config.config.model, "m1");
  assert.equal(config.config.thinkingOption, "max");
  assert.equal(config.config.models.length, 2);
  assert.equal(config.config.thinkingOptions.length, 2);

  assert.ok(events.some((event) => event.type === "session.ready"));
  assert.ok(events.some((event) => event.type === "session.commands"));
});

test("configure republishes the committed values", () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { catalog: CATALOG });

  session.open("open-1", ["prompt.message", "session.configure"]);
  events.length = 0;

  session.configure({ model: "m2", mode: "always_allow", thinkingOption: "low" });

  const config = events.at(-1);
  assert.ok(config && config.type === "session.config");
  assert.equal(config.config.model, "m2");
  assert.equal(config.config.mode, "always_allow");
  assert.equal(config.config.thinkingOption, "low");
});

test("model, effort, mode and cwd are forwarded to the CLI", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    catalog: CATALOG,
    config: { model: "m2", thinkingOption: "low", mode: "always_allow" },
  });

  await session.prompt(prompt("hello"));

  const call = readFileSync(join(cli.dir, "args.log"), "utf8");
  assert.match(call, /-p hello/);
  assert.match(call, /--output-format stream-json/);
  assert.match(call, /-C /);
  assert.match(call, /--model m2/);
  assert.match(call, /--effort low/);
  assert.match(call, /--permission-mode always_allow/);
});

test("closing during a turn still reports the cancel", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  const running = session.prompt(prompt());
  await new Promise((resolve) => setTimeout(resolve, 200));

  await session.close();
  await running;

  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "canceled"));
  await assert.rejects(session.prompt(prompt()), /Session is closed/);
});

test("a missing binary fails the turn instead of leaving it started", async () => {
  const events: ProviderEvent[] = [];
  const session = new Session({
    id: "session-x",
    config: { cwd: tmpdir(), env: {}, mcpServers: {}, settings: {}, persist: false },
    launch: { command: "/nonexistent/doubao-xyz", args: [], env: {} },
    catalog: () => fallbackCatalog(),
    emit: (event) => events.push(event),
  });

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "SPAWN_ERROR");
});

test("a process killed by a signal reports the signal", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `kill -TERM $$`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "SIGNAL_SIGTERM");
  assert.match(failed.error?.message ?? "", /killed by SIGTERM/);
});

test("SIGKILL mentions the likely causes", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `kill -KILL $$`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "SIGNAL_SIGKILL");
  assert.match(failed.error?.message ?? "", /OOM|external kill/);
});

test("a signal death drops the native session so the next turn starts clean", async () => {
  const cli = fakeCli(
    [
      `first="$(dirname "$0")/first"`,
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `if [ ! -f "$first" ]; then`,
      `  touch "$first"`,
      `  kill -TERM $$`,
      `fi`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"recovered"}}'`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt("one"));

  const cleared = events
    .filter((event) => event.type === "session.persistence")
    .at(-1);
  assert.ok(cleared && cleared.type === "session.persistence");
  assert.deepEqual(cleared.persistence.data, { doubaoSessionId: null });

  await session.prompt(prompt("two"));

  const calls = readFileSync(join(cli.dir, "args.log"), "utf8").trim().split("\n");
  assert.doesNotMatch(calls[1], /--resume/);
  assert.match(assistantText(events), /recovered/);
});

test("interrupting an idle session is a no-op", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.interrupt();
  assert.ok(!events.some((event) => event.type === "session.turn"));
});

test("a prompt over the byte cap is rejected before spawning", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { limits: { maxPromptBytes: 5 } });

  await assert.rejects(session.prompt(prompt("hello world")), /limit is 5/);
  assert.equal(existsSync(join(cli.dir, "args.log")), false);
});

test("stderr is bounded before it reaches the error message", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `yes x | head -c 5000 >&2`,
      `exit 7`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { limits: { maxStderrBytes: 100 } });

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "EXIT_7");
  assert.match(failed.error?.message ?? "", /\[truncated\]/);
  assert.ok(Buffer.byteLength(failed.error?.message ?? "") < 400);
});

test("a turn that exceeds the time limit is stopped", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    limits: { maxTurnMs: 300, stallTimeoutMs: 0 },
  });

  const started = Date.now();
  await session.prompt(prompt());
  const elapsed = Date.now() - started;

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "TURN_TIMEOUT");
  // Well below the fake CLI's 10s sleep: the timer, not the process, ended the turn.
  assert.ok(elapsed < 8000);
});

test("a silent turn is stopped by the stall watchdog", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    limits: { maxTurnMs: 0, stallTimeoutMs: 300 },
  });

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "TURN_STALLED");
});

test("assistant output is capped and marked", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}'`,
      `exit 0`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { limits: { maxAssistantBytes: 10 } });

  await session.prompt(prompt());

  assert.match(assistantText(events), /output truncated/);
  assert.ok(
    events.some((event) => event.type === "session.turn" && event.state === "completed"),
  );
});

test("tool calls become timeline items with running and completed states", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo hi"}}]}}'`,
      `printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":[{"type":"text","text":"exited with code 0. stdout: hi"}]}]}}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"done"}}'`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const tools = events
    .filter((event) => event.type === "timeline.item" && event.item.type === "tool_call")
    .map((event) => (event.type === "timeline.item" && event.item.type === "tool_call" ? event.item : null))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  assert.equal(tools.length, 2);
  assert.equal(tools[0].id, "tool:t1");
  assert.equal(tools[0].status, "running");
  assert.equal(tools[1].status, "completed");
  assert.equal(tools[1].detail.type, "shell");
  if (tools[1].detail.type === "shell") {
    assert.equal(tools[1].detail.command, "echo hi");
    assert.equal(tools[1].detail.exitCode, 0);
  }
});

test("a recursive doubao command is blocked and the turn is canceled", async () => {
  const cli = fakeCli(
    [
      `printf '%s\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"doubao -p hi"}}]}}'`,
      `exec sleep 10`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  assert.ok(
    events.some(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "notification" &&
        /Blocked a recursive command/.test(event.item.message),
    ),
  );

  const tool = events
    .filter((event) => event.type === "timeline.item" && event.item.type === "tool_call")
    .at(-1);
  assert.ok(tool && tool.type === "timeline.item" && tool.item.type === "tool_call");
  assert.equal(tool.item.status, "canceled");
  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "canceled"));
});

test("a prompt above the CLI code point limit is rejected", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await assert.rejects(session.prompt(prompt("a".repeat(262_145))), /code points/);
  assert.equal(existsSync(join(cli.dir, "args.log")), false);
});

test("open warns that tool calls cannot be gated", () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  session.open("open-1", ["prompt.message"]);

  const notice = events.find((event) => event.type === "session.notice");
  assert.ok(notice && notice.type === "session.notice");
  assert.equal(notice.notice.severity, "warning");
  assert.match(notice.notice.title, /approval/i);
});

test("the approval notice can be suppressed for controlled environments", () => {
  process.env.DOUBAO_PASEO_SUPPRESS_NOTICES = "1";
  try {
    const cli = fakeCli(HAPPY);
    const events: ProviderEvent[] = [];
    const session = createSession(cli, cli.dir, events);
    session.open("open-1", ["prompt.message"]);
    assert.ok(!events.some((event) => event.type === "session.notice"));
  } finally {
    delete process.env.DOUBAO_PASEO_SUPPRESS_NOTICES;
  }
});
test("prompts about the provider carry a safety note", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt("分析下这个 doubao Provider"));

  const call = readFileSync(join(cli.dir, "args.log"), "utf8");
  assert.match(call, /Paseo safety note/);
  assert.match(call, /Do not execute/);
});

test("ordinary prompts do not carry the safety note", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt("今天有哪些新闻"));

  const call = readFileSync(join(cli.dir, "args.log"), "utf8");
  assert.doesNotMatch(call, /Paseo safety note/);
});

test("a prompt exactly at the cap is accepted", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { limits: { maxPromptBytes: 5 } });

  await session.prompt(prompt("hello"));

  assert.equal(existsSync(join(cli.dir, "args.log")), true);
  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "completed"));
});

test("a turn is refused when free disk is below the floor", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    limits: { minFreeDiskBytes: Number.MAX_SAFE_INTEGER },
  });

  await assert.rejects(session.prompt(prompt()), /MB is required/);
  assert.equal(existsSync(join(cli.dir, "args.log")), false);
  assert.ok(!events.some((event) => event.type === "session.turn"));
});

test("a burst of deltas is coalesced into a few timeline updates", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `for i in {1..2000}; do printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"xxxxxxxxxxxxxxxx"}}}'; done`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"done"}}'`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    limits: { maxAssistantBytes: 8 * 1024 * 1024 },
  });

  const started = Date.now();
  await session.prompt(prompt());
  const elapsed = Date.now() - started;

  const updates = events.filter(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  ).length;

  assert.ok(updates > 0);
  assert.ok(updates < 32, `expected coalescing, got ${updates} updates`);
  assert.ok(elapsed < 3000, `turn took ${elapsed}ms`);
});

test("a persisted native id is used on the very first turn", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    persistence: { version: 1, data: { doubaoSessionId: "restored-42" } },
  });

  await session.prompt(prompt("hi"));

  assert.match(readFileSync(join(cli.dir, "args.log"), "utf8"), /--resume restored-42/);
});

test("no session id in the stream means no persistence event", async () => {
  const cli = fakeCli(
    `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"ok"}}'`,
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  assert.ok(!events.some((event) => event.type === "session.persistence"));
  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "completed"));
});

test("configure with null resets to the catalogue defaults", () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { catalog: CATALOG });

  session.open("open-1", ["prompt.message", "session.configure"]);
  session.configure({ model: "m2", mode: "always_allow", thinkingOption: "low" });
  events.length = 0;

  session.configure({ model: null, mode: null, thinkingOption: null });

  const config = events.at(-1);
  assert.ok(config && config.type === "session.config");
  assert.equal(config.config.model, "m1");
  assert.equal(config.config.thinkingOption, "max");
  assert.equal(config.config.mode, "ask_risky");
});

test("the session is usable after an interrupt", async () => {
  const cli = fakeCli(
    [
      `first="$(dirname "$0")/first"`,
      `if [ ! -f "$first" ]; then`,
      `  touch "$first"`,
      `  printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `  exec sleep 10`,
      `fi`,
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"second ok"}}'`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  const first = session.prompt(prompt("first"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await session.interrupt();
  await first;

  await session.prompt(prompt("second"));

  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "canceled"));
  assert.equal(
    events.filter((event) => event.type === "session.turn" && event.state === "completed").length,
    1,
  );
  assert.match(assistantText(events), /second ok/);
});

test("close is idempotent", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.close();
  await session.close();
  assert.equal(session.canStopRuntime(), true);
});

test("the prompt is passed as one argv entry, never through a shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doubao-argv-"));
  const command = join(dir, "doubao");
  writeFileSync(
    command,
    `#!/usr/bin/env bash
{
  echo "argc=$#"
  for arg in "$@"; do printf '[%s]\\n' "$arg"; done
} >> "$(dirname "$0")/argv.log"
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"ok"}}'
`,
  );
  chmodSync(command, 0o755);

  const events: ProviderEvent[] = [];
  const session = createSession({ command, dir }, dir, events);
  const text = 'a"; rm -rf /tmp/x; echo "b $(whoami) `id`';

  await session.prompt(prompt(text));

  const lines = readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n");
  // -p <text> --output-format stream-json -C <cwd>
  assert.equal(lines[0], "argc=6");
  assert.ok(lines.includes(`[${text}]`));
});

test("an assistant message over the cap is truncated too", async () => {
  const cli = fakeCli(
    `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"${"y".repeat(200)}"}]}}'`,
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, { limits: { maxAssistantBytes: 20 } });

  await session.prompt(prompt());

  assert.match(assistantText(events), /output truncated/);
  assert.ok(Buffer.byteLength(assistantText(events)) < 80);
});
