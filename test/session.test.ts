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

function fakeCli(body: string, options: { captureStdin?: boolean } = {}): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "doubao-fake-"));
  const command = join(dir, "doubao");
  const capture = options.captureStdin ? `cat > "${dir}/stdin.log"\n` : "";
  writeFileSync(
    command,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/args.log"\n${capture}${body}\n`,
  );
  chmodSync(command, 0o755);
  return { command, dir };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
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

function assistantMessages(events: ProviderEvent[]): Array<{ id: string; text: string }> {
  return events
    .filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")
    .map((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message"
        ? { id: event.item.id, text: event.item.text }
        : { id: "", text: "" },
    );
}

function assistantText(events: ProviderEvent[]): string {
  return assistantMessages(events)
    .map((item) => item.text)
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

test("exit code 4 (login_required) preserves the persisted native session id", async () => {
  const cli = fakeCli(
    [`echo "login_required: 需要登录" >&2`, `exit 4`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    persistence: { version: 1, data: { doubaoSessionId: "keep-me" } },
  });

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "EXIT_4");
  assert.equal(
    (session.getPersistence()?.data as { doubaoSessionId?: string } | undefined)?.doubaoSessionId,
    "keep-me",
  );
  assert.ok(!events.some((event) => event.type === "session.persistence"));
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

test("a CLI result error reports its message, structured code and cloud log_id", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const cli = fakeCli(
    `printf '%s\\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"log_id":"cloud-trace-123","errors":["User input is required"],"error":{"code":"interaction_required"},"permission_denials":[{"tool_name":"Bash","tool_use_id":"t1","prompt":"rm -rf /"}]}'`,
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "DOUBAO_INTERACTION_REQUIRED");
  assert.equal(failed.error?.message, "User input is required (log_id: cloud-trace-123)");
  assert.ok(warn.mock.calls.some(({ arguments: args }) => String(args[0]).includes("log_id: cloud-trace-123")));

  assert.ok(
    events.some(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "notification" &&
        /automatically denied.*Bash/i.test(event.item.message),
    ),
  );
});

test("a trailing NDJSON event without a newline is still processed on exit", async () => {
  const cli = fakeCli(
    `printf '%s' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-tail","result":{"type":"text","content":"no-newline"}}'`,
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  assert.equal(assistantText(events), "no-newline");
  assert.equal(
    (session.getPersistence()?.data as { doubaoSessionId?: string } | undefined)?.doubaoSessionId,
    "sess-tail",
  );
});

test("a shorter authoritative replacement after streamed deltas is still emitted", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"${"a".repeat(300)}"}}}'`,
      `sleep 0.15`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"short final"}}'`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const messages = assistantMessages(events);
  assert.ok(messages.length >= 2, "expected initial delta flush and shorter final replacement");
  assert.equal(messages.at(-1)?.text, "short final");
});

test("multi-message turns with tool calls emit distinct assistant items in order", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\\n' '{"type":"stream_event","message_id":"m1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Checking..."}}}'`,
      `printf '%s\\n' '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Checking..."}]}}'`,
      `printf '%s\\n' '{"type":"assistant","message":{"id":"m1:tool_use:t1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.txt"}}]}}'`,
      `printf '%s\\n' '{"type":"user","message":{"id":"m1:tool_result:t1","content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":[{"type":"text","text":"42"}]}]}}'`,
      `printf '%s\\n' '{"type":"stream_event","message_id":"m2","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer: 42"}}}'`,
      `printf '%s\\n' '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Answer: 42"}]}}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"message_id":"m2","result":{"type":"text","content":"Answer: 42"}}'`,
    ].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.prompt(prompt());

  const messages = assistantMessages(events);
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
  assert.equal(messages[0].text, "Checking...");
  assert.equal(messages[1].text, "Answer: 42");
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

test("back-to-back concurrent prompts on the same session are rejected synchronously", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  // Fire second prompt immediately while first is still awaiting freeDiskBytes().
  const first = session.prompt(prompt("first"));
  await assert.rejects(session.prompt(prompt("second")), /already running/);

  await waitFor(() => events.some((event) => event.type === "session.persistence"));
  await session.interrupt();
  await first;

  const calls = readFileSync(join(cli.dir, "args.log"), "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "canceled"));
});

test("a second prompt while one is running is rejected", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  const running = session.prompt(prompt("long"));
  await waitFor(() => events.some((event) => event.type === "session.persistence"));

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
  await waitFor(() => events.some((event) => event.type === "session.persistence"));
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

test("open publishes catalogue defaults, empty slash commands and per-model thinking options", () => {
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

  const commands = events.find((event) => event.type === "session.commands");
  assert.ok(commands && commands.type === "session.commands");
  assert.deepEqual(commands.commands, []);

  assert.ok(events.some((event) => event.type === "session.ready"));
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

test("model, effort, mode and cwd are forwarded to the CLI while prompt goes over stdin", async () => {
  const cli = fakeCli(HAPPY, { captureStdin: true });
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    catalog: CATALOG,
    config: { model: "m2", thinkingOption: "low", mode: "always_allow" },
  });

  await session.prompt(prompt("hello"));

  const call = readFileSync(join(cli.dir, "args.log"), "utf8");
  assert.match(call, /-p -/);
  assert.match(call, /--output-format stream-json/);
  assert.match(call, /-C /);
  assert.match(call, /--model m2/);
  assert.match(call, /--effort low/);
  assert.match(call, /--permission-mode always_allow/);
  assert.equal(readFileSync(join(cli.dir, "stdin.log"), "utf8"), "hello");
});

test("closing during a turn still reports the cancel", async () => {
  const cli = fakeCli(
    [`printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`, `exec sleep 10`].join("\n"),
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  const running = session.prompt(prompt());
  await waitFor(() => events.some((event) => event.type === "session.persistence"));

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

test("an oversized stream-json line is stopped without throwing into the daemon", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const cli = fakeCli(
    `"${process.execPath}" -e "process.stdout.write('x'.repeat(${16 * 1024 * 1024 + 1}))"`,
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events, {
    persistence: { version: 1, data: { doubaoSessionId: "before-overflow" } },
  });

  await session.prompt(prompt());

  const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
  assert.ok(failed && failed.type === "session.turn");
  assert.equal(failed.error?.code, "STREAM_LINE_TOO_LARGE");
  assert.match(failed.error?.message ?? "", /16777216 bytes/);
  assert.ok(warn.mock.calls.some(({ arguments: args }) =>
    String(args[0]).includes("stream-json line above")));
  assert.ok(events.some((event) => event.type === "session.persistence" &&
    (event.persistence.data as { doubaoSessionId?: unknown }).doubaoSessionId === null));
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

test("a recursive doubao command is blocked and late tool_result cannot overwrite canceled", async () => {
  const cli = fakeCli(
    [
      `printf '%s\\n' '{"type":"system","session_id":"sess-1"}'`,
      `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"doubao -C /tmp -p hi"}}]}}'`,
      `printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":[{"type":"text","text":"late output"}]}]}}'`,
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

test("user prompts mentioning provider or tests are forwarded unmodified", async () => {
  const cli = fakeCli(HAPPY, { captureStdin: true });
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);
  const original = "分析下 auth provider 的实现并补充单元测试 (npm test)";

  await session.prompt(prompt(original));

  assert.equal(readFileSync(join(cli.dir, "stdin.log"), "utf8"), original);
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
  await waitFor(() => events.some((event) => event.type === "session.persistence"));
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

test("prompts with shell metacharacters and >128 KiB size pass verbatim over stdin", async () => {
  const cli = fakeCli(
    `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"text","content":"ok"}}'`,
    { captureStdin: true },
  );
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);
  const text = `a"; rm -rf /tmp/x; echo "b $(whoami) \`id\`\n${"z".repeat(160 * 1024)}`;

  await session.prompt(prompt(text));

  const received = readFileSync(join(cli.dir, "stdin.log"), "utf8");
  assert.equal(received, text);
  const args = readFileSync(join(cli.dir, "args.log"), "utf8").trim();
  assert.equal(args, `-p - --output-format stream-json -C ${cli.dir}`);
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
