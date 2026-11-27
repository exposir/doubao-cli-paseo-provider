import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderCatalog,
  ProviderEvent,
  ProviderPrompt,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { fallbackCatalog, MODES } from "../server/catalog.js";
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

test("interrupting an idle session is a no-op", async () => {
  const cli = fakeCli(HAPPY);
  const events: ProviderEvent[] = [];
  const session = createSession(cli, cli.dir, events);

  await session.interrupt();
  assert.ok(!events.some((event) => event.type === "session.turn"));
});
