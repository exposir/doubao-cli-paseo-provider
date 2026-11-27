import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { clearCatalogCache } from "../server/catalog.js";
import { createDoubaoProvider } from "../server/provider.js";

function fakeCli(): { launch: ProviderLaunch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "doubao-provider-"));
  const command = join(dir, "doubao");
  writeFileSync(
    command,
    `#!/usr/bin/env bash
case "$1" in
  auth) exit 0 ;;
  model)
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"model_list","models":[{"id":"m1","name":"Model One","is_default":true,"efforts":["low","high"],"default_effort":"high"}]}}'
    ;;
  --list)
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"session_list","count":1,"sessions":[{"session_id":"s-1","title":"Hello"}]}}'
    ;;
esac
`,
  );
  chmodSync(command, 0o755);
  return { launch: { command, args: [], env: {} }, dir };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
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

test("status reports unavailable when the daemon has no launch", async () => {
  const registration = createDoubaoProvider();
  const status = await registration.status!({ launch: undefined });
  assert.equal(status.available, false);
  assert.match(status.diagnostic ?? "", /not found on PATH/);
});

test("status treats a successful auth check as available", async () => {
  const registration = createDoubaoProvider();
  const status = await registration.status!({ launch: { command: "/bin/true", args: [], env: {} } });
  assert.equal(status.available, true);
});

test("status reports a diagnostic when auth fails", async () => {
  const registration = createDoubaoProvider();
  const status = await registration.status!({ launch: { command: "/bin/false", args: [], env: {} } });
  assert.equal(status.available, false);
  assert.match(status.diagnostic ?? "", /not usable/);
});

test("connect requires protocol version 1", async () => {
  const registration = createDoubaoProvider();
  await assert.rejects(
    registration.connect({ versions: [2], capabilities: [], launch: { command: "x", args: [], env: {} } }),
    /version 1/,
  );
});

test("connect requires launch parameters", async () => {
  const registration = createDoubaoProvider();
  await assert.rejects(
    registration.connect({ versions: [1], capabilities: [] }),
    /launch parameters/,
  );
});

test("connect keeps only the capabilities both sides support", async () => {
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.list", "session.revert.both", "permission"],
    launch: { command: "/bin/true", args: [], env: {} },
  });

  assert.deepEqual([...connection.capabilities].sort(), ["prompt.message", "session.list"]);
  await connection.close();
});

test("catalog requests map the model list payload", async () => {
  clearCatalogCache();
  const { launch } = fakeCli();
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.list"],
    launch,
  });

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({ type: "catalog", requestId: "cat-1" });
  await waitFor(() => events.some((event) => event.type === "catalog"));

  const event = events.find((entry) => entry.type === "catalog");
  assert.ok(event && event.type === "catalog");
  assert.equal(event.requestId, "cat-1");
  assert.equal(event.catalog.models[0].id, "m1");
  assert.equal(event.catalog.defaultModel, "m1");
  assert.equal(event.catalog.defaultThinkingOption, "high");

  await connection.close();
});

test("session list requests map the list payload", async () => {
  const { launch } = fakeCli();
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.list"],
    launch,
  });

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({ type: "sessions", requestId: "list-1", cwd: "/tmp" });
  await waitFor(() => events.some((event) => event.type === "sessions"));

  const event = events.find((entry) => entry.type === "sessions");
  assert.ok(event && event.type === "sessions");
  assert.equal(event.sessions.length, 1);
  assert.equal(event.sessions[0].title, "Hello");

  await connection.close();
});

test("a prompt for an unknown session reports a failed prompt result", async () => {
  const { launch } = fakeCli();
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message"],
    launch,
  });

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.prompt",
    sessionId: "missing",
    prompt: {
      clientMessageId: "c-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hi" }] },
    },
  });
  await waitFor(() => events.some((event) => event.type === "session.prompt_result"));

  const event = events.find((entry) => entry.type === "session.prompt_result");
  assert.ok(event && event.type === "session.prompt_result");
  assert.equal(event.result.type, "failed");
  if (event.result.type === "failed") {
    assert.match(event.result.error.message, /Unknown session/);
  }

  await connection.close();
});

test("an unnegotiated request is rejected", async () => {
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message"],
    launch: { command: "/bin/true", args: [], env: {} },
  });

  await assert.rejects(
    connection.send({
      type: "session.revert",
      requestId: "r-1",
      sessionId: "s",
      target: {},
    } as never),
  );

  await connection.close();
});

test("close is idempotent and later sends are rejected", async () => {
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message"],
    launch: { command: "/bin/true", args: [], env: {} },
  });

  await connection.close();
  await connection.close();
  await assert.rejects(connection.send({ type: "catalog", requestId: "x" }), /closed/);
});

test("the catalogue cache key follows command, args and environment", async () => {
  const registration = createDoubaoProvider();
  const base: ProviderLaunch = { command: "doubao", args: ["--x"], env: { A: "1" } };

  const first = await registration.getCatalogCacheKey!({ scope: "workspace", cwd: "/tmp", launch: base });
  const again = await registration.getCatalogCacheKey!({
    scope: "workspace",
    cwd: "/tmp",
    launch: { command: "doubao", args: ["--x"], env: { A: "1" } },
  });
  const changed = await registration.getCatalogCacheKey!({
    scope: "workspace",
    cwd: "/tmp",
    launch: { command: "doubao", args: ["--x"], env: { A: "2" } },
  });

  assert.equal(first, again);
  assert.notEqual(first, changed);
});

test("getCatalogCacheKey is undefined without a launch", async () => {
  const registration = createDoubaoProvider();
  assert.equal(await registration.getCatalogCacheKey!({ scope: "workspace", cwd: "/tmp" }), undefined);
});

function promptCli(): { launch: ProviderLaunch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "doubao-flow-"));
  const command = join(dir, "doubao");
  writeFileSync(
    command,
    `#!/usr/bin/env bash
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-9"}'
printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"OK!"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-9","result":{"type":"text","content":"OK!"}}'
`,
  );
  chmodSync(command, 0o755);
  return { launch: { command, args: [], env: {} }, dir };
}

test("a full open → prompt → configure → close flow works through the connection", async () => {
  clearCatalogCache();
  const { launch, dir } = promptCli();
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "session.configure",
      "session.persistence",
      "session.can_stop_runtime",
      "session.list",
    ],
    launch,
  });

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "s-1",
    history: "skip",
    config: { cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await waitFor(() => events.some((event) => event.type === "session.ready"));

  await connection.send({
    type: "session.prompt",
    sessionId: "s-1",
    prompt: {
      clientMessageId: "c-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hi" }] },
    },
  });
  await waitFor(
    () => events.some((event) => event.type === "session.turn" && event.state === "completed"),
  );

  const text = events
    .filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")
    .map((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message" ? event.item.text : "",
    )
    .join("");
  assert.equal(text, "OK!");
  assert.ok(events.some((event) => event.type === "session.persistence"));

  await connection.send({
    type: "session.configure",
    requestId: "cfg-1",
    sessionId: "s-1",
    changes: { model: "m2" },
  });
  await waitFor(() => events.some((event) => event.type === "request.completed"));

  await connection.send({ type: "session.can_stop_runtime", requestId: "stop-1", sessionId: "s-1" });
  await waitFor(() => events.some((event) => event.type === "session.can_stop_runtime"));
  const canStop = events.find((event) => event.type === "session.can_stop_runtime");
  assert.ok(canStop && canStop.type === "session.can_stop_runtime");
  assert.equal(canStop.canStop, true);

  await connection.send({ type: "session.close", requestId: "close-1", sessionId: "s-1" });
  await waitFor(() => events.some((event) => event.type === "session.closed"));

  await connection.close();
});

test("opening the same session twice reports a failed request", async () => {
  clearCatalogCache();
  const { launch, dir } = promptCli();
  const registration = createDoubaoProvider();
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message"],
    launch,
  });

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  const open = {
    type: "session.open" as const,
    requestId: "open-1",
    sessionId: "s-1",
    history: "skip" as const,
    config: { cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: false },
  };

  await connection.send(open);
  await waitFor(() => events.some((event) => event.type === "session.ready"));

  await connection.send({ ...open, requestId: "open-2" });
  await waitFor(() => events.some((event) => event.type === "request.failed"));

  const failed = events.find((event) => event.type === "request.failed");
  assert.ok(failed && failed.type === "request.failed");
  assert.match(failed.error.message, /already open/);

  await connection.close();
});

function sleepCli(): { launch: ProviderLaunch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "doubao-sleep-"));
  const command = join(dir, "doubao");
  writeFileSync(
    command,
    `#!/usr/bin/env bash
if [ "$1" = "model" ]; then
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"model_list","models":[]}}'
  exit 0
fi
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'
exec sleep 10
`,
  );
  chmodSync(command, 0o755);
  return { launch: { command, args: [], env: {} }, dir };
}

test("concurrent turns are capped per connection", async () => {
  clearCatalogCache();
  const { launch, dir } = sleepCli();
  const registration = createDoubaoProvider({
    limits: { maxConcurrentTurns: 1, stallTimeoutMs: 0 },
  });
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message"],
    launch,
  });

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  for (const id of ["s-1", "s-2"]) {
    await connection.send({
      type: "session.open",
      requestId: `open-${id}`,
      sessionId: id,
      history: "skip",
      config: { cwd: dir, env: {}, mcpServers: {}, settings: {}, persist: false },
    });
  }
  await waitFor(() => events.filter((event) => event.type === "session.ready").length === 2);

  const prompt = (sessionId: string) => ({
    type: "session.prompt" as const,
    sessionId,
    prompt: {
      clientMessageId: `c-${sessionId}`,
      delivery: "auto" as const,
      input: { type: "message" as const, content: [{ type: "text" as const, text: "hi" }] },
    },
  });

  await connection.send(prompt("s-1"));
  await new Promise((resolve) => setTimeout(resolve, 250));

  await connection.send(prompt("s-2"));
  await waitFor(() =>
    events.some((event) => event.type === "session.prompt_result" && event.result.type === "failed"),
  );

  const failed = events.find(
    (event) => event.type === "session.prompt_result" && event.result.type === "failed",
  );
  assert.ok(failed && failed.type === "session.prompt_result");
  if (failed.result.type === "failed") {
    assert.equal(failed.result.error.code, "TOO_MANY_TURNS");
  }

  await connection.close();
});
