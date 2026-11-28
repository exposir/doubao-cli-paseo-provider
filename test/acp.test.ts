import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  isProviderCapability,
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderPersistence,
  type ProviderPrompt,
} from "@getpaseo/plugin/server/provider";
import { createDoubaoAcpProvider } from "../server/acp.js";
import {
  ACP_MODES,
  AcpJsonRpcClient,
  asRecord,
  buildAcpElicitationRequest,
  buildAcpElicitationResponse,
  buildAcpPermissionRequest,
  buildAcpToolItem,
  formatAcpPrompt,
  formatAcpPromptBlocks,
  mapAcpCommands,
  mapAcpConfig,
  mapAcpError,
  records,
  toAcpMcpServers,
} from "../server/acp-protocol.js";
import { baseCliArgs, hasAcpFlag } from "../server/cli.js";
import { createDoubaoProvider, resolveTransport } from "../server/provider.js";
import type { Limits } from "../server/limits.js";

const CAPABILITIES = [
  "prompt.message", "prompt.command", "prompt.image", "session.configure", "session.persistence",
  "session.can_stop_runtime", "session.launch_wrap", "session.list", "permission", "request.cancel",
];
const MCP = {
  local: { type: "stdio", command: "node", args: ["server.js"], env: { KEY: "test" } },
  remote: { type: "http", url: "https://example.test/mcp", headers: { Accept: "application/json" } },
  events: { type: "sse", url: "https://example.test/events" },
} as const satisfies Record<string, NonNullable<Extract<ProviderInput, { type: "session.open" }>["config"]["mcpServers"]>[string]>;

const FIXTURE = String.raw`
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const log = (data) => appendFileSync(join(dir, "wire.log"), JSON.stringify({ pid: process.pid, ...data }) + "\n");
const args = process.argv.slice(2);
log({ type: "start", args, childMarker: process.env.PASEO_DOUBAO_CHILD,
  noUpdate: process.env.DOUBAO_CLI_NO_UPDATE_CHECK, wrapped: process.env.WRAPPED, sessionEnv: process.env.SESSION_ENV });

if (args.join(" ") === "auth status") {
  if (process.env.FAKE_AUTH_FAIL) console.error("login_required");
  process.exit(process.env.FAKE_AUTH_FAIL ? 4 : 0);
}
if (args.join(" ") === "model list --output-format json") {
  if (process.env.FAKE_MODEL_HANG) {
    process.once("SIGTERM", () => {
      log({ type: "catalog_aborted" });
      process.exit(143);
    });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else {
    console.log(JSON.stringify({ result: { models: [
      { id: "m1", name: "Model 1", is_default: true, efforts: ["low", "high"], default_effort: "high" },
      { id: "m2", name: "Model 2", efforts: ["medium", "max"], default_effort: "max" },
    ] } }));
    process.exit(0);
  }
}
if (args.join(" ") !== "acp serve" && args.join(" ") !== "--acp") process.exit(2);
process.on("exit", (code) => log({ type: "exit", code }));
process.on("SIGINT", () => log({ type: "SIGINT" }));
if (process.env.FAKE_START_CRASH) {
  console.error("startup diagnostic: service disconnected 中文");
  process.exit(7);
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const response = (id, result) => send({ id, result });
const reject = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, sessionUpdate, fields) => send({ method: "session/update", params: {
  sessionId, update: { sessionUpdate, ...fields },
} });
const chunk = (id, kind, text, messageId) => update(id, kind, { messageId, content: { type: "text", text } });
const commands = (id) => update(id, "available_commands_update", { availableCommands: [
  { name: "compact", description: "Compact context" },
  { name: "cloud-skill", description: "Cloud Skill", input: { hint: "name" } },
] });
const modes = () => ({
  currentModeId: mode,
  availableModes: ["default", "plan", "bypass_permissions"].map((id) => ({ id, name: id })),
});
const options = () => [
  { type: "select", id: "model", currentValue: model, category: "model",
    options: ["m1", "m2"].map((value) => ({ value, name: value })) },
  ...(process.env.FAKE_FIXED_EFFORT && model === "m2" ? [] : [
    { type: "select", id: "effort", currentValue: effort, category: "thought_level",
      options: (model === "m1" ? ["low", "high"] : ["medium", "max"]).map((value) => ({ value, name: value })) },
  ]),
];
let mode = "default";
let model = "m1";
let effort = "high";
let nextNew = 0;
let pending;
const newId = () => "acp-" + process.pid + "-" + ++nextNew;
const finish = (request, sessionId) => {
  appendFileSync(join(dir, "bound-" + sessionId), "");
  response(request, { stopReason: "end_turn" });
  pending = undefined;
};
const tool = {
  toolCallId: "edit-1", kind: "edit", title: "Edit", status: "pending",
  rawInput: { file_path: "/work/a.ts", old_str: "foo", new_str: "bar" },
  locations: [{ path: "/work/a.ts", line: 7 }],
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  log({ type: "wire", method, id, params, result: msg.result, error: msg.error });
  if (!method && id === "elicitation-1" && pending) {
    if (pending.scenario === "elicitation-deny") {
      chunk(pending.sessionId, "agent_message_chunk", "questions cancelled");
      finish(pending.id, pending.sessionId);
    } else if (msg.result?.action === "accept" && pending.scenario !== "elicitation-stall") {
      chunk(pending.sessionId, "agent_message_chunk", "questions answered");
      finish(pending.id, pending.sessionId);
    }
    return;
  }
  if (!method && (id === "fs-read-1" || id === "fs-read-slice-1") && pending) {
    log({ type: "fs-result", fsResult: msg.result, fsError: msg.error });
    chunk(pending.sessionId, "agent_message_chunk", "fs callback complete");
    finish(pending.id, pending.sessionId);
    return;
  }
  if (!method && id === "permission-1" && pending) {
    if (pending.scenario === "permission-stall" || msg.result?.outcome.outcome === "cancelled") return;
    const allowed = msg.result?.outcome.optionId === "allow_once";
    update(pending.sessionId, "tool_call_update", {
      toolCallId: tool.toolCallId, status: allowed ? "completed" : "failed", rawOutput: allowed ? "saved" : "denied",
    });
    chunk(pending.sessionId, "agent_message_chunk", allowed ? "approved" : "rejected");
    finish(pending.id, pending.sessionId);
    return;
  }
  switch (method) {
    case "initialize":
      if (process.env.FAKE_INITIALIZE_HANG) {
        console.error("connection to Doubao timed out");
      } else if (params.protocolVersion === 1 && params.clientInfo.name === "paseo" && params.clientInfo.version === "1") {
        response(id, { protocolVersion: 1, agentInfo: { name: "doubao", version: "2.38.4" } });
      } else reject(id, -32602, "initialize params invalid");
      break;
    case "session/new": {
      const sessionId = newId();
      commands(sessionId);
      response(id, { sessionId, modes: modes(), configOptions: options() });
      break;
    }
    case "session/load": {
      const { sessionId } = params;
      if (sessionId === "needs-login") return reject(id, -32000, "login_required");
      if (sessionId !== "old" && !existsSync(join(dir, "bound-" + sessionId))) {
        return reject(id, -32002, "not_found");
      }
      chunk(sessionId, "user_message_chunk", "previous ", "u1");
      chunk(sessionId, "user_message_chunk", "question", "u1");
      chunk(sessionId, "agent_message_chunk", "previous answer", "a1");
      update(sessionId, "tool_call", { ...tool, status: "completed" });
      commands(sessionId);
      response(id, { modes: modes(), configOptions: options() });
      break;
    }
    case "session/list":
      if (process.env.FAKE_LIST_HANG) return;
      response(id, params.cursor
        ? { sessions: [{ sessionId: "old", cwd: params.cwd ?? dir, title: "Previous ACP session",
            updatedAt: "2026-11-28T00:00:00.000Z" }], nextCursor: null }
        : { sessions: [], nextCursor: "next" });
      break;
    case "session/set_mode":
      mode = params.modeId;
      update(params.sessionId, "current_mode_update", { currentModeId: mode });
      response(id, {});
      break;
    case "session/set_config_option":
      if (params.configId === "effort" && !options().some((option) => option.id === "effort")) {
        return reject(id, -32602, "Unknown configuration");
      }
      if (params.configId === "model") {
        model = params.value;
        effort = model === "m1" ? "high" : process.env.FAKE_FIXED_EFFORT ? "fixed" : "max";
      } else effort = params.value;
      update(params.sessionId, "config_option_update", { configOptions: options() });
      response(id, { configOptions: options() });
      break;
    case "session/prompt": {
      const { sessionId, prompt } = params;
      if (prompt.some(({ type }) => type !== "text" && type !== "resource_link")) {
        return reject(id, -32602, "Unsupported content");
      }
      const text = prompt.map((block) => block.text).join("\n");
      const scenario = text.split("\n")[0];
      if (scenario === "login") return reject(id, -32000, "login_required");
      if (scenario === "busy") return reject(id, -32901, "busy");
      if (scenario === "missing") return reject(id, -32002, "not_found");
      if (scenario === "rpc-canceled") return reject(id, -32800, "requestCancelled");
      if (scenario === "crash") {
        console.error("[cli-chat] cloud transport closed 中文");
        process.exit(9);
      }
      if (scenario === "stderr-heartbeat") {
        const timer = setInterval(() => process.stderr.write("working\\n"), 60);
        setTimeout(() => {
          clearInterval(timer);
          chunk(sessionId, "agent_message_chunk", "stderr kept the turn alive");
          finish(id, sessionId);
        }, 260);
        return;
      }
      if (scenario === "config-notify") {
        mode = "plan";
        effort = "low";
        update(sessionId, "current_mode_update", { currentModeId: mode });
        update(sessionId, "config_option_update", { configOptions: options() });
      }
      pending = { id, sessionId, scenario };
      if (scenario === "wait") return;
      if (scenario === "hang") {
        const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        log({ type: "helper", helperPid: helper.pid });
        return;
      }
      if (scenario.startsWith("permission")) {
        chunk(sessionId, "agent_thought_chunk", "planning edit");
        update(sessionId, "plan", { entries: [{ content: "Update a.ts", status: "in_progress" }] });
        update(sessionId, "tool_call", { ...tool,
          content: [{ type: "diff", path: "/work/a.ts", oldText: "foo", newText: "bar" }] });
        send({ id: "permission-1", method: "session/request_permission", params: {
          sessionId, toolCall: tool, options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        } });
        return;
      }
      if (scenario.startsWith("elicitation")) {
        pending = { id, sessionId, scenario };
        send({ id: "elicitation-1", method: "elicitation/create", params: {
          mode: "form",
          sessionId,
          message: "Configure the project",
          requestedSchema: {
            type: "object",
            required: ["color", "features", "name", "framework"],
            properties: {
              color: {
                type: "string", title: "Color",
                oneOf: [{ const: "red", title: "Red" }, { const: "blue", title: "Blue" }],
              },
              features: {
                type: "array", title: "Features",
                items: { type: "string", anyOf: [
                  { const: "docs", title: "Docs" },
                  { const: "tests", title: "Tests" },
                ] },
              },
              "features:text": { type: "string", title: "Other features" },
              name: { type: "string", title: "Name" },
              framework: {
                type: "string", title: "Framework",
                oneOf: [{ const: "react", title: "React" }, { const: "vue", title: "Vue" }],
              },
              "framework:text": { type: "string", title: "Other framework" },
              notes: { type: "string", title: "Notes" },
            },
          },
        } });
        return;
      }
      if (scenario === "fs-read" || scenario === "fs-read-slice") {
        pending = { id, sessionId, scenario };
        const target = text.split("\n")[1] || process.env.FAKE_FS_TARGET || join(dir, "notes.txt");
        const fsParams = { sessionId, path: target };
        if (scenario === "fs-read-slice") {
          fsParams.line = 2;
          fsParams.limit = 2;
        }
        if (process.env.FAKE_FS_LINE) fsParams.line = Number(process.env.FAKE_FS_LINE);
        if (process.env.FAKE_FS_LIMIT) fsParams.limit = Number(process.env.FAKE_FS_LIMIT);
        const requestId = scenario === "fs-read-slice" ? "fs-read-slice-1" : "fs-read-1";
        send({ id: requestId, method: "fs/read_text_file", params: fsParams });
        return;
      }
      if (scenario === "utf-assistant" || scenario === "utf-reasoning" || scenario === "utf-shared") {
        if (scenario === "utf-shared") chunk(sessionId, "agent_thought_chunk", "a中", "r1");
        const kind = scenario === "utf-reasoning" ? "agent_thought_chunk" : "agent_message_chunk";
        chunk(sessionId, kind, "中", "a");
        chunk(sessionId, kind, "🙂end", "a");
        chunk(sessionId, kind, "ignored", "a");
      } else {
        for (let n = 0; n < 20; n++) chunk(sessionId, "agent_message_chunk", n ? "." : text, "a");
      }
      finish(id, sessionId);
      break;
    }
    case "session/cancel":
      if (pending && pending.scenario !== "hang") {
        response(pending.id, { stopReason: "cancelled" });
        pending = undefined;
      }
      break;
    default:
      if (id !== undefined && method) reject(id, -32601, "Method not found");
  }
});
`;

type Event<T extends ProviderEvent["type"]> = Extract<ProviderEvent, { type: T }>;
type OpenInput = Extract<ProviderInput, { type: "session.open" }>;
type Wire = {
  type: string;
  args?: string[];
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  id?: string | number;
  pid: number;
  helperPid?: number;
  childMarker?: string;
  noUpdate?: string;
  wrapped?: string;
  sessionEnv?: string;
};

function fixture(t: TestContext, env: ProviderLaunch["env"] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doubao-acp-fake-"));
  const script = join(dir, "acp.mjs");
  writeFileSync(script, FIXTURE);
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    try {
      for (const close of cleanup) await close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const launch: ProviderLaunch = { command: process.execPath, args: [script, "acp", "serve"], env };
  function wire(): Wire[] {
    try {
      return readFileSync(join(dir, "wire.log"), "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as Wire);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  return { dir, launch, wire, cleanup };
}

async function waitUntil<T>(get: () => T | undefined | false, description: string, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = get();
    if (value) return value;
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function attach(
  cli: ReturnType<typeof fixture>,
  options: {
    limits?: Partial<Limits>;
    startupTimeoutMs?: number;
    capabilities?: readonly string[];
    useRegisteredCommand?: boolean;
  } = {},
) {
  const registration = createDoubaoAcpProvider({
    limits: { minFreeDiskBytes: 0, idleRuntimeMs: 0, ...options.limits },
    startupTimeoutMs: options.startupTimeoutMs ?? 2000,
    command: options.useRegisteredCommand ? [cli.launch.command, ...cli.launch.args] : undefined,
  });
  const connection = await registration.connect({
    versions: [1], capabilities: options.capabilities ?? CAPABILITIES,
    launch: options.useRegisteredCommand ? undefined : cli.launch,
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  cli.cleanup.push(async () => {
    await connection.close();
    for (const event of events) {
      const parsed = ProviderEventSchema.safeParse(event);
      assert.ok(parsed.success, parsed.error?.message);
    }
  });
  function event<T extends ProviderEvent["type"]>(
    type: T, predicate: (value: Event<T>) => boolean = () => true, from = 0,
  ): Promise<Event<T>> {
    return waitUntil(() => events.slice(from).find((value): value is Event<T> =>
      value.type === type && predicate(value as Event<T>)), type);
  }
  async function open(sessionId = "s", extra: {
    persistence?: ProviderPersistence;
    history?: OpenInput["history"];
    config?: Partial<OpenInput["config"]>;
  } = {}) {
    const input: OpenInput = {
      type: "session.open", sessionId, requestId: `open-${sessionId}`,
      history: extra.history ?? "skip",
      persistence: extra.persistence,
      config: { cwd: cli.dir, env: {}, settings: {}, mcpServers: {}, persist: true, ...extra.config },
    };
    await connection.send(input);
    await waitUntil(
      () => events.some((value) =>
        (value.type === "session.ready" && value.sessionId === sessionId)
        || (value.type === "request.failed" && value.requestId === input.requestId)),
      "session.ready",
    );
    const failure = events.find((value) =>
      value.type === "request.failed" && value.requestId === input.requestId);
    if (failure?.type === "request.failed") {
      assert.fail(`ACP session open failed: ${failure.error.code ?? "ERROR"}: ${failure.error.message}`);
    }
  }
  async function run(text: string, sessionId = "s") {
    const from = events.length;
    await connection.send(prompt(text, sessionId));
    return event("session.turn", (value) => value.sessionId === sessionId && value.state !== "started", from);
  }
  return { ...cli, connection, events, event, open, run };
}

function prompt(text: string, sessionId = "s"): Extract<ProviderInput, { type: "session.prompt" }> {
  return {
    type: "session.prompt", sessionId,
    prompt: {
      clientMessageId: text, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] },
    },
  };
}

function saved(sessionId: string | null): ProviderPersistence {
  return { version: 1, data: { sessionId } };
}

function methods(wire: Wire[], pid?: number): string[] {
  return wire.flatMap((entry) => entry.method && (!pid || entry.pid === pid) ? [entry.method] : []);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Boolean(state && !state.startsWith("Z"));
  } catch {
    return false;
  }
}

test("ACP negotiation keeps stream-json as default and opts into ACP explicitly or by environment", () => {
  assert.equal(resolveTransport(undefined, {}), "stream-json");
  assert.equal(resolveTransport(undefined, { DOUBAO_PASEO_TRANSPORT: "ACP" }), "acp");
  assert.equal(resolveTransport("stream-json", { DOUBAO_PASEO_TRANSPORT: "acp" }), "stream-json");
  const registration = createDoubaoProvider({ transport: "acp" });
  assert.equal(registration.id, "doubao");
  assert.deepEqual(registration.command, ["doubao", "acp", "serve"]);
  assert.equal("launchWrap" in registration && registration.launchWrap === true, isProviderCapability("session.launch_wrap"));
});

test("ACP status strips acp serve and --acp and applies the no-update guard", async (t) => {
  const { launch, wire } = fixture(t);
  const registration = createDoubaoAcpProvider();
  assert.deepEqual(baseCliArgs(["--flag", "acp", "serve"]), ["--flag"]);
  assert.deepEqual(baseCliArgs(["--acp"]), []);
  assert.deepEqual(
    baseCliArgs(["--model", "m1", "acp", "serve", "--effort", "high"]),
    ["--model", "m1", "--effort", "high"],
  );
  assert.deepEqual(
    baseCliArgs(["acp", "serve", "--acp", "--permission-mode", "always_allow"]),
    ["--permission-mode", "always_allow"],
  );
  assert.equal(hasAcpFlag(["acp", "serve", "--model", "m1"]), true);
  assert.equal(hasAcpFlag(["--acp", "--effort", "high"]), true);
  assert.equal(hasAcpFlag(["--model", "m1"]), false);
  assert.deepEqual(baseCliArgs(["--other"]), ["--other"]);
  assert.equal((await registration.status!({ launch })).available, true);
  const fail = await registration.status!({
    launch: { ...launch, args: [launch.args[0], "--acp"], env: { FAKE_AUTH_FAIL: "1" } },
  });
  assert.equal(fail.available, false);
  assert.match(fail.diagnostic ?? "", /doubao login/);
  assert.equal((await registration.status!({})).available, false);
  assert.deepEqual(wire().map(({ args, noUpdate }) => ({ args, noUpdate })), [
    { args: ["auth", "status"], noUpdate: "1" }, { args: ["auth", "status"], noUpdate: "1" },
  ]);
});

test("ACP error mapping retains remote messages and classifies the Doubao codes", () => {
  const cases = [
    [-32000, "DOUBAO_LOGIN_REQUIRED"], [-32002, "DOUBAO_SESSION_NOT_FOUND"],
    [-32602, "DOUBAO_INVALID_ARGUMENTS"], [-32901, "DOUBAO_SESSION_BUSY"],
    [-32800, "DOUBAO_REQUEST_CANCELLED"], [-32603, "DOUBAO_INTERNAL_ERROR"],
    [-12345, "DOUBAO_ACP_ERROR"],
  ] as const;
  for (const [number, code] of cases) {
    const error = mapAcpError({ code: number, message: "Doubao detail" });
    assert.equal(error.code, code);
    assert.equal(error.message, "Doubao detail");
  }
});

test("ACP config maps selected modes and grouped effort choices with legacy settings", () => {
  const actual = mapAcpConfig(
    { currentModeId: "bypass_permissions", availableModes: [{ id: "bypass_permissions", name: "Bypass" }] },
    [
      { id: "model", category: "model", currentValue: "m1", options: [{ value: "m1", name: "Model 1" }] },
      { id: "effort", category: "thought_level", currentValue: "low",
        options: [{ group: "thinking", options: [{ value: "low", name: "Low" }] }] },
    ],
    { models: [], modes: ACP_MODES, defaultMode: "default" },
  );
  assert.equal(actual.mode, "bypass_permissions");
  assert.equal(actual.modes[0]?.isUnattended, true);
  assert.equal(actual.model, "m1");
  assert.equal(actual.thinkingOption, "low");
  assert.deepEqual(actual.thinkingOptions.map(({ id }) => id), ["low"]);
  assert.deepEqual(actual.settings, []);
});

test("ACP commands default built-ins to command kind and cloud entries to skill kind", () => {
  const commands = mapAcpCommands([
    { name: "init" }, { name: "/review" }, { name: "compact" }, { name: "agent-new" },
    { name: "cloud-search" }, { name: "explicit", kind: "command" },
  ]);
  assert.deepEqual(commands.map((command) => [
    command.name,
    (command as typeof command & { kind?: "command" | "skill" }).kind,
  ]), [
    ["init", "command"], ["review", "command"], ["compact", "command"], ["agent-new", "command"],
    ["cloud-search", "skill"], ["explicit", "command"],
  ]);
});

test("ACP tool cards normalize snake_case input, retain diffs and locations, and cap output", () => {
  const edit = buildAcpToolItem({
    kind: "edit", title: "Edit", toolCallId: "native", status: "completed",
    rawInput: { file_path: "/work/file", old_string: "a", new_string: "" },
    rawOutput: { diff: "@@ -1 +0 @@\n-a" }, locations: [{ path: "/work/file", line: 1 }],
  }, "item");
  assert.equal(edit.callId, "native");
  assert.deepEqual(edit.detail, { type: "edit", filePath: "/work/file", oldString: "a", newString: "", unifiedDiff: "@@ -1 +0 @@\n-a" });
  assert.deepEqual(edit.metadata?.locations, [{ path: "/work/file", line: 1 }]);
  assert.deepEqual(buildAcpToolItem({
    kind: "read", rawInput: { file_path: "README", offset: 5, limit: 10 }, rawOutput: { content: "content" },
  }, "read").detail, { type: "read", filePath: "README", content: "content", offset: 5, limit: 10 });
  const shell = buildAcpToolItem({
    kind: "execute", rawInput: { cmd: "ls" }, rawOutput: { output: "🙂".repeat(20_000), exit_code: 0 },
  }, "shell").detail;
  assert.equal(shell.type, "shell");
  assert.equal(shell.command, "ls");
  assert.equal(shell.exitCode, 0);
  assert.ok(Buffer.byteLength(shell.output ?? "") <= 64 * 1024);
  assert.match(shell.output ?? "", /\[truncated\]$/);
  assert.ok(!shell.output?.includes("�"));
  assert.deepEqual(buildAcpToolItem({
    kind: "edit", title: "WriteFile", rawInput: { file_path: "out", file_text: "abc" },
  }, "write").detail, { type: "write", filePath: "out", content: "abc" });
  assert.equal(buildAcpToolItem({ kind: "search", rawInput: { pattern: "foo" } }, "search").detail.type, "search");
  assert.equal(buildAcpToolItem({ kind: "fetch", rawInput: { url: "https://example.test" } }, "fetch").detail.type, "fetch");
  assert.equal(buildAcpToolItem({ title: "MCP tool", rawOutput: [1, 2] }, "unknown").detail.type, "unknown");
  const statusRead = buildAcpToolItem({
    title: "查看系统信息和 Node 版本", kind: "read", locations: [], status: "in_progress",
  }, "status-read");
  if (statusRead.detail.type !== "read") assert.fail("expected a read tool detail");
  assert.equal(statusRead.detail.filePath, "查看系统信息和 Node 版本");
  assert.deepEqual(statusRead.metadata?.locations, []);
  const argsShell = buildAcpToolItem({
    kind: "execute", title: "Shell", rawInput: { command: "npm", args: ["test", "--", "unit"] },
  }, "args-shell");
  assert.ok(argsShell.detail.type === "shell");
  assert.equal(argsShell.detail.command, "npm test -- unit");
  const thinking = buildAcpToolItem({
    kind: "think", title: "Thinking", rawOutput: { output: "considering options" },
  }, "thinking");
  assert.deepEqual(thinking.detail, {
    type: "plain_text", label: "Thinking", icon: "brain", text: "considering options",
  });
  const switching = buildAcpToolItem({
    kind: "switch_mode", title: "Switch mode", rawOutput: { output: "plan" },
  }, "switching");
  assert.deepEqual(switching.detail, {
    type: "plain_text", label: "Switch mode", icon: "sparkles", text: "plan",
  });
});

test("ACP permission builder maps known allow and deny actions using tool details", () => {
  const request = buildAcpPermissionRequest("p", {
    toolCall: { title: "Edit", kind: "edit", rawInput: { file_path: "a", old_str: "x", new_str: "y" } },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_always" },
      { optionId: "no", name: "Deny", kind: "reject_always" },
      { optionId: "unknown", name: "Unknown", kind: "custom" },
    ],
  });
  assert.equal(request.detail?.type, "edit");
  assert.equal(request.description, "a");
  assert.deepEqual(request.actions?.map(({ id, behavior }) => [id, behavior]), [["yes", "allow"], ["no", "deny"]]);

  for (const [toolCall, expected] of [
    [{ title: "Bash", kind: "execute", rawInput: { cmd: "  uname -a &&\n node -v  " } }, "uname -a && node -v"],
    [{ title: "Read", kind: "read", rawInput: { file_path: "/work/a.ts" } }, "/work/a.ts"],
    [{ title: "Write", kind: "write", rawInput: { file_path: "/work/b.ts" } }, "/work/b.ts"],
    [{ title: "Edit", kind: "edit", rawInput: { file_path: "/work/c.ts" } }, "/work/c.ts"],
    [{ title: "Fetch", kind: "fetch", rawInput: { url: "https://example.test/docs" } }, "https://example.test/docs"],
    [{ title: "Search", kind: "search", rawInput: { pattern: "needle" } }, "needle"],
  ] as const) {
    assert.equal(
      buildAcpPermissionRequest("p", { toolCall, options: [] }).description,
      expected,
    );
  }

  const fallback = buildAcpPermissionRequest("p", {
    toolCall: { title: "Inspect", kind: "other", content: [
      { type: "content", content: { type: "text", text: " \n " } },
      { type: "content", content: { type: "text", text: "  first\nline  " } },
      { type: "content", content: { type: "text", text: "second line" } },
    ] },
    options: [],
  });
  assert.equal(fallback.description, "first line");

  const emptyDetail = buildAcpPermissionRequest("p", {
    toolCall: {
      title: "Bash", kind: "execute", rawInput: { cmd: " \n " },
      content: [{ type: "content", content: { type: "text", text: " fallback text " } }],
    },
    options: [],
  });
  assert.equal(emptyDetail.description, "fallback text");

  const duplicate = buildAcpPermissionRequest("p", {
    toolCall: { title: "Bash", kind: "execute", rawInput: { cmd: " Bash " } }, options: [],
  });
  assert.equal("description" in duplicate, false);

  const capped = buildAcpPermissionRequest("p", {
    toolCall: { title: "Bash", kind: "execute", rawInput: { cmd: "x".repeat(300) } }, options: [],
  });
  assert.equal(Array.from(capped.description ?? "").length, 240);
  assert.match(capped.description ?? "", /\.\.\.$/);
});

test("ACP elicitation maps Paseo questions and constructs schema-valid answers", () => {
  const spec = buildAcpElicitationRequest("question-1", {
    mode: "form",
    sessionId: "s",
    message: "Configure the project",
    requestedSchema: {
      type: "object",
      required: ["origin", "stack", "project", "framework"],
      properties: {
        origin: {
          type: "string", title: "Color",
          oneOf: [{ const: "red", title: "Red" }, { const: "blue", title: "Blue" }],
        },
        stack: {
          type: "array", title: "Features",
          items: { type: "string", anyOf: [
            { const: "docs", title: "Docs" },
            { const: "tests", title: "Tests" },
          ] },
        },
        "stack:text": { type: "string", title: "Other features" },
        project: { type: "string", title: "Name" },
        framework: {
          type: "string", title: "Framework",
          oneOf: [{ const: "react", title: "React" }, { const: "vue", title: "Vue" }],
        },
        "framework:text": { type: "string", title: "Other framework" },
        notes: { type: "string", title: "Notes" },
      },
    },
  });

  assert.equal(spec.request.kind, "question");
  assert.equal(spec.request.name, "AskUserQuestion");
  assert.equal(spec.request.title, "Configure the project");
  assert.match(spec.request.description ?? "", /Color/);
  assert.deepEqual(spec.questions.map(({ id, header }) => [id, header]), [
    ["origin", "Color"], ["stack", "Features"], ["project", "Name"], ["framework", "Framework"],
    ["notes", "Notes"],
  ]);
  const input = asRecord(spec.request.input);
  const questions = records(input?.questions);
  assert.equal(questions[1]?.multiSelect, true);
  assert.equal(questions[1]?.allowOther, true);
  assert.deepEqual(questions[1]?.options, [
    { label: "Docs", description: "" }, { label: "Tests", description: "" },
  ]);
  assert.equal(questions[2]?.multiSelect, false);
  assert.equal(questions[4]?.allowEmpty, true);

  assert.deepEqual(buildAcpElicitationResponse(spec, {
    behavior: "allow",
    updatedInput: { answers: {
      Color: "Blue",
      Features: "Docs, custom feature",
      Name: "Doubao CLI",
      Framework: "Svelte",
    } },
  }), {
    action: "accept",
    content: {
      origin: "blue",
      stack: ["docs"],
      "stack:text": "custom feature",
      project: "Doubao CLI",
      "framework:text": "Svelte",
    },
  });
  assert.deepEqual(buildAcpElicitationResponse(spec, { behavior: "deny" }), { action: "cancel" });
  assert.deepEqual(buildAcpElicitationResponse(spec, { behavior: "allow" }), { action: "cancel" });

  const duplicates = buildAcpElicitationRequest("question-2", {
    message: "Choose",
    requestedSchema: {
      type: "object",
      properties: {
        a: { type: "string", title: "Choice" },
        b: { type: "string", title: "Choice" },
      },
    },
  });
  assert.deepEqual(duplicates.questions.map(({ header }) => header), ["Choice", "Choice (2)"]);
});

const ATTACHMENTS: Extract<ProviderPrompt["input"], { type: "message" }>["content"] = [
  { type: "text", text: "Review attachments" },
  { type: "image", data: "BASE64_IMAGE_BYTES", mimeType: "image/png" },
  { type: "github_pr", mimeType: "application/github-pr", number: 12, title: "Fix bug",
    url: "https://example.test/pull/12", body: "details" },
  { type: "github_issue", mimeType: "application/github-issue", number: 3, title: "Report bug",
    url: "https://example.test/issues/3" },
  { type: "review", mimeType: "application/paseo-review", mode: "base", cwd: "/tmp", comments: [] },
  { type: "uploaded_file", id: "file", path: "/tmp/test.txt", size: 10, fileName: "test.txt", mimeType: "text/plain" },
];

test("ACP prompt and MCP conversion use wire-compatible data", () => {
  const blocks = formatAcpPromptBlocks({
    clientMessageId: "c", delivery: "auto", input: { type: "message", content: ATTACHMENTS },
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  for (const part of ["Attached image (image/png)", "Pull request #12", "Issue #3", "Code review", "test.txt"]) {
    assert.ok(blocks[0].text.includes(part));
  }
  assert.ok(!blocks[0].text.includes("BASE64_IMAGE_BYTES"));
  assert.deepEqual(formatAcpPromptBlocks({
    clientMessageId: "cmd", delivery: "auto", input: { type: "command", name: "compact", arguments: "note" },
  }), [{ type: "text", text: "/compact note" }]);
  assert.deepEqual(toAcpMcpServers(MCP), [
    { name: "local", command: "node", args: ["server.js"], env: [{ name: "KEY", value: "test" }] },
    { name: "remote", type: "http", url: "https://example.test/mcp", headers: [{ name: "Accept", value: "application/json" }] },
    { name: "events", type: "sse", url: "https://example.test/events", headers: [] },
  ]);
});

test("ACP JSON-RPC replays only matching new-session updates in line order, including fragmented UTF-8", async () => {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const delivered: string[] = [];
  const replies: unknown[] = [];
  outgoing.on("data", (chunk: Buffer) => replies.push(JSON.parse(chunk.toString())));
  const client = new AcpJsonRpcClient(incoming, outgoing, {
    notification: (_method, params) => delivered.push(String(params.text)),
    request: (method, _params, reply) => {
      assert.equal(method, "reverse");
      reply.result({ ok: true });
      reply.error(-32603, "duplicate");
    },
  });
  const pending = client.newSession({ cwd: "/tmp", mcpServers: [] }, { timeoutMs: 500 }, (id) => delivered.push(id));
  const frame = (body: object) => JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n";
  const update = (sessionId: string, text: string) => frame({ method: "session/update", params: { sessionId, text } });
  const lines = Buffer.from(update("wrong", "discard") + update("native", "中")
    + update("native", "early") + frame({ id: 1, result: { sessionId: "native" } })
    + update("native", "after") + frame({ id: "reverse-id", method: "reverse", params: {} }));
  const split = lines.indexOf(Buffer.from("中")) + 1;
  incoming.write(lines.subarray(0, split));
  incoming.end(lines.subarray(split));
  await pending;
  assert.deepEqual(delivered, ["native", "中", "early", "after"]);
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: "reverse-id", result: { ok: true } });
  assert.equal(replies.length, 2);
});

test("ACP JSON-RPC rejects timed out and aborted requests and ignores their late frames", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new AcpJsonRpcClient(input, output);
  await assert.rejects(client.request("timeout", {}, { timeoutMs: 10 }), { code: "ACP_REQUEST_TIMEOUT" });
  const controller = new AbortController();
  const aborted = client.request("aborted", {}, { signal: controller.signal, timeoutMs: 2000 });
  controller.abort(new Error("aborted"));
  await assert.rejects(aborted, /aborted/);
  const next = client.request("next", {}, { timeoutMs: 500 });
  input.end([
    '{"jsonrpc":"2.0","id":1,"result":{}}',
    '{"jsonrpc":"2.0","id":2,"result":{}}',
    '{"jsonrpc":"2.0","id":3,"result":{"value":3}}',
  ].join("\n"));
  assert.deepEqual(await next, { value: 3 });
});

test("ACP discovery uses cached model list and paginated session list returns loadable persistence", async (t) => {
  const a = await attach(fixture(t));
  await a.connection.send({ type: "catalog", requestId: "cat", cwd: a.dir });
  const { catalog } = await a.event("catalog", (event) => event.requestId === "cat");
  assert.deepEqual(catalog.models.map(({ id }) => id), ["m1", "m2"]);
  assert.deepEqual(catalog.models[1].thinkingOptions?.map(({ id }) => id), ["medium", "max"]);
  assert.equal(catalog.modes[2]?.isUnattended, true);
  await a.connection.send({ type: "catalog", requestId: "cached", cwd: a.dir });
  await a.event("catalog", (event) => event.requestId === "cached");
  assert.equal(a.wire().length, 1);
  assert.deepEqual(a.wire()[0].args, ["model", "list", "--output-format", "json"]);

  await a.connection.send({ type: "sessions", requestId: "list", cwd: a.dir, limit: 1, query: "previous" });
  const { sessions } = await a.event("sessions");
  assert.deepEqual(sessions, [{ persistence: saved("old"), cwd: a.dir, title: "Previous ACP session", updatedAt: "2026-11-28T00:00:00.000Z" }]);
  const probes = a.wire().filter((entry) => entry.method === "session/list");
  assert.deepEqual(probes.map(({ params }) => params?.cursor), [undefined, "next"]);
  assert.ok(a.wire().some((entry) => entry.type === "exit" && entry.pid === probes[0].pid));
  await a.open("s", { persistence: sessions[0].persistence });
  assert.equal(a.wire().find((entry) => entry.method === "session/load")?.params?.sessionId, "old");
});

test("ACP open advertises commands from before session/new resolves and persists only after first turn", async (t) => {
  const a = await attach(fixture(t), { useRegisteredCommand: true });
  assert.ok(a.connection.capabilities.includes("prompt.image"));
  await a.open();
  const commandEvent = await a.event("session.commands");
  assert.deepEqual(commandEvent.commands.map(({ name, argumentHint }) => [name, argumentHint]), [
    ["compact", undefined], ["cloud-skill", "name"],
  ]);
  assert.ok(a.events.indexOf(commandEvent) < a.events.findIndex(({ type }) => type === "session.ready"));
  assert.equal((await a.event("session.opened")).persistence, undefined);
  assert.equal(a.events.some(({ type }) => type === "session.persistence"), false);

  await a.connection.send({
    type: "session.prompt", sessionId: "s", prompt: {
      clientMessageId: "command", delivery: "auto", input: { type: "command", name: "compact", arguments: "summary" },
    },
  });
  await a.event("session.turn", ({ state }) => state === "completed");
  const rpc = a.wire().find(({ method }) => method === "session/prompt");
  assert.deepEqual(rpc?.params?.prompt, [{ type: "text", text: "/compact summary" }]);
  assert.deepEqual((await a.event("session.persistence")).persistence, saved(String(rpc?.params?.sessionId)));
  const answer = a.events.filter((event): event is Event<"timeline.item"> =>
    event.type === "timeline.item" && event.item.type === "assistant_message");
  assert.equal(answer.length, 1);
  assert.ok(answer[0].item.type === "assistant_message");
  assert.equal(answer[0].item.text, "/compact summary" + ".".repeat(19));
});

test("ACP session/load replays history only on request and forwards commands in both modes", async (t) => {
  const a = await attach(fixture(t));
  await a.open("replay", { persistence: saved("old"), history: "replay" });
  await a.open("skip", { persistence: saved("old") });
  const history = a.events.filter((event): event is Event<"timeline.item"> => event.type === "timeline.item");
  assert.ok(history.every((event) => event.sessionId === "replay"));
  assert.deepEqual(history.map(({ item }) =>
    item.type === "user_message" || item.type === "assistant_message" ? item.text : item.type), [
    "previous question", "previous answer", "tool_call",
  ]);
  assert.deepEqual(a.events.filter((event) => event.type === "session.commands").map((event) => event.sessionId), ["replay", "skip"]);
});

test("ACP injects systemPrompt once into the first plain message and keeps the user timeline clean", async (t) => {
  const a = await attach(fixture(t));
  await a.open("fresh", { config: { systemPrompt: "  Follow project rules.  " } });
  const from = a.events.length;
  await a.connection.send(prompt("hello", "fresh"));
  await a.event("session.turn", ({ state }) => state === "completed", from);
  const first = a.wire().find(({ method }) => method === "session/prompt");
  assert.match(String(records(first?.params?.prompt)[0]?.text),
    /^\[System instructions\]\nFollow project rules\.\n\n\[User message\]\n/);
  const user = a.events.find((event, index) => index >= from && event.type === "timeline.item" &&
    event.item.type === "user_message");
  assert.ok(user?.type === "timeline.item" && user.item.type === "user_message");
  assert.equal(user.item.text, "hello");

  const second = a.events.length;
  await a.connection.send(prompt("again", "fresh"));
  await a.event("session.turn", ({ state }) => state === "completed", second);
  const prompts = a.wire().filter(({ method }) => method === "session/prompt");
  assert.deepEqual(prompts.at(-1)?.params?.prompt, [{ type: "text", text: "again" }]);
});

test("ACP skips systemPrompt for slash commands and resumed sessions", async (t) => {
  const a = await attach(fixture(t));
  await a.open("slash", { config: { systemPrompt: "Do not prepend commands" } });
  await a.connection.send({
    type: "session.prompt", sessionId: "slash", prompt: {
      clientMessageId: "compact", delivery: "auto", input: { type: "command", name: "compact", arguments: "summary" },
    },
  });
  await a.event("session.turn", ({ sessionId, state }) => sessionId === "slash" && state === "completed");
  assert.deepEqual(a.wire().find(({ method }) => method === "session/prompt")?.params?.prompt,
    [{ type: "text", text: "/compact summary" }]);

  await a.open("resumed", { persistence: saved("old"), config: { systemPrompt: "Do not prepend resumed" } });
  await a.connection.send(prompt("hello", "resumed"));
  await a.event("session.turn", ({ sessionId, state }) => sessionId === "resumed" && state === "completed");
  const resumed = a.wire().filter(({ method }) => method === "session/prompt").at(-1);
  assert.deepEqual(resumed?.params?.prompt, [{ type: "text", text: "hello" }]);
});

test("ACP session/load not_found clears stale persistence, warns and falls back to session/new", async (t) => {
  const a = await attach(fixture(t));
  await a.open("s", { persistence: saved("missing"), history: "replay" });
  assert.deepEqual(methods(a.wire()), ["initialize", "session/load", "session/new"]);
  assert.deepEqual((await a.event("session.persistence")).persistence, saved(null));
  assert.equal((await a.event("session.notice")).notice.severity, "warning");
  assert.equal((await a.run("test fallback")).state, "completed");
});

test("ACP launches with config.wrap, child environment and MCP servers on new and load", async (t) => {
  const a = await attach(fixture(t));
  const config: Partial<OpenInput["config"]> & { wrap?: readonly [string, ...string[]] } = {
    mcpServers: MCP, env: { SESSION_ENV: "set" },
  };
  // Paseo 0.15 does not negotiate launch sidecars.
  const wrap = a.connection.capabilities.includes("session.launch_wrap");
  if (wrap) config.wrap = ["/usr/bin/env", "WRAPPED=1"];
  await a.open("new", { config });
  await a.open("load", { config, persistence: saved("old") });
  for (const rpc of a.wire().filter((entry) => entry.method === "session/new" || entry.method === "session/load")) {
    assert.deepEqual(rpc.params?.mcpServers, toAcpMcpServers(MCP));
    const start = a.wire().find((entry) => entry.pid === rpc.pid && entry.type === "start");
    assert.equal(start?.wrapped, wrap ? "1" : undefined);
    assert.equal(start?.sessionEnv, "set");
    assert.equal(start?.noUpdate, "1");
    assert.match(start?.childMarker ?? "", /^paseo-/);
  }
});

test("ACP fs/read_text_file serves bounded workspace text with line slicing and rejects unsafe paths", async (t) => {
  const a = await attach(fixture(t));
  await a.open();
  writeFileSync(join(a.dir, "notes.txt"), "one\ntwo\nthree\nfour");
  await a.connection.send(prompt("fs-read"));
  await a.event("session.turn", ({ state }) => state === "completed");
  assert.deepEqual(a.wire().find(({ id }) => id === "fs-read-1")?.result, { content: "one\ntwo\nthree\nfour" });

  const sliceFrom = a.events.length;
  await a.connection.send(prompt("fs-read-slice"));
  await a.event("session.turn", ({ state }) => state === "completed", sliceFrom);
  assert.deepEqual(a.wire().find(({ id }) => id === "fs-read-slice-1")?.result, { content: "two\nthree" });

  const outside = mkdtempSync(join(tmpdir(), "doubao-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(a.dir, "escape.txt"));
  writeFileSync(join(a.dir, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
  writeFileSync(join(a.dir, "large.txt"), "x".repeat(64 * 1024 + 1));

  for (const [target, expectedError] of [
    [join(outside, "secret.txt"), "outside"],
    [join(a.dir, "escape.txt"), "outside"],
    [join(a.dir, "binary.txt"), "Binary"],
    [join(a.dir, "large.txt"), "64 KiB"],
    [a.dir, "regular file"],
    [join(a.dir, "missing.txt"), "ENOENT"],
  ]) {
    const started = a.events.length;
    await a.connection.send(prompt(`fs-read\n${target}`));
    await a.event("session.turn", ({ state }) => state === "completed", started);
    const reply = a.wire().filter(({ id }) => id === "fs-read-1").at(-1);
    assert.equal(asRecord(reply?.error)?.code, -32602, target);
    assert.match(String(asRecord(reply?.error)?.message), new RegExp(expectedError));
  }
});

test("ACP sends attachment summaries over stdio and never sends an image block", async (t) => {
  const a = await attach(fixture(t));
  await a.open();
  await a.connection.send({
    type: "session.prompt", sessionId: "s", prompt: {
      clientMessageId: "attachment", delivery: "auto", input: { type: "message", content: ATTACHMENTS },
    },
  });
  await a.event("session.turn", ({ state }) => state === "completed");
  const rpc = a.wire().find(({ method }) => method === "session/prompt");
  assert.deepEqual(rpc?.params?.prompt, formatAcpPromptBlocks({
    clientMessageId: "attachment", delivery: "auto", input: { type: "message", content: ATTACHMENTS },
  }));
});

test("ACP sends workspace text files as resource links and falls back for binary or outside files", async (t) => {
  const a = await attach(fixture(t));
  await a.open();
  writeFileSync(join(a.dir, "inside.txt"), "inside text");
  const outside = mkdtempSync(join(tmpdir(), "doubao-upload-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "outside.txt"), "outside text");
  writeFileSync(join(a.dir, "binary.bin"), Buffer.from([1, 0, 2]));
  await a.connection.send({
    type: "session.prompt", sessionId: "s", prompt: {
      clientMessageId: "files", delivery: "auto", input: { type: "message", content: [
        { type: "uploaded_file", id: "in", path: join(a.dir, "inside.txt"), size: 10,
          fileName: "inside.txt", mimeType: "text/plain" },
        { type: "uploaded_file", id: "out", path: join(outside, "outside.txt"), size: 12,
          fileName: "outside.txt", mimeType: "text/plain" },
        { type: "uploaded_file", id: "bin", path: join(a.dir, "binary.bin"), size: 3,
          fileName: "binary.bin", mimeType: "application/octet-stream" },
      ] },
    },
  });
  await a.event("session.turn", ({ state }) => state === "completed");
  const blocks = records(a.wire().find(({ method }) => method === "session/prompt")?.params?.prompt);
  assert.equal(blocks[0]?.type, "resource_link");
  assert.match(String(blocks[0]?.uri), /inside\.txt$/);
  assert.equal(blocks[0]?.name, "inside.txt");
  assert.equal(blocks[1]?.type, "text");
  const fallback = String(blocks[1]?.text);
  assert.match(fallback, /outside\.txt/);
  assert.match(fallback, /binary\.bin/);

  writeFileSync(join(a.dir, "budget-one.txt"), "a".repeat(40 * 1024));
  writeFileSync(join(a.dir, "budget-two.txt"), "b".repeat(40 * 1024));
  const budgetFrom = a.events.length;
  await a.connection.send({
    type: "session.prompt", sessionId: "s", prompt: {
      clientMessageId: "budget", delivery: "auto", input: { type: "message", content: [
        { type: "uploaded_file", id: "one", path: join(a.dir, "budget-one.txt"), size: 40 * 1024,
          fileName: "budget-one.txt", mimeType: "text/plain" },
        { type: "uploaded_file", id: "two", path: join(a.dir, "budget-two.txt"), size: 40 * 1024,
          fileName: "budget-two.txt", mimeType: "text/plain" },
      ] },
    },
  });
  await a.event("session.turn", ({ state }) => state === "completed", budgetFrom);
  const budgetBlocks = records(a.wire().filter(({ method }) => method === "session/prompt").at(-1)?.params?.prompt);
  assert.equal(budgetBlocks[0]?.type, "resource_link");
  assert.match(String(budgetBlocks[0]?.uri), /budget-one\.txt$/);
  assert.equal(budgetBlocks[1]?.type, "text");
  assert.match(String(budgetBlocks[1]?.text), /budget-two\.txt/);
});

test("ACP materializes valid images privately and cleans them when the session closes", async (t) => {
  const a = await attach(fixture(t));
  await a.open();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64");
  await a.connection.send({
    type: "session.prompt", sessionId: "s", prompt: {
      clientMessageId: "images", delivery: "auto", input: { type: "message", content: [
        { type: "text", text: "Inspect these images" },
        { type: "image", data: png.toString("base64"), mimeType: "image/jpeg" },
        { type: "image", data: "not base64", mimeType: "image/png" },
        { type: "image", data: oversized, mimeType: "image/png" },
      ] },
    },
  });
  await a.event("session.turn", ({ state }) => state === "completed");
  const rpc = a.wire().find(({ method }) => method === "session/prompt");
  const blocks = records(rpc?.params?.prompt);
  assert.ok(blocks.every(({ type }) => type === "text"));
  assert.equal(blocks.length, 1);
  const text = String(blocks[0]?.text);
  const path = /\[Attached image: ([^\]]+? \(image\/jpeg\))\. Read this image file directly to inspect it\.\]/
    .exec(text)?.[1]?.replace(/ \(image\/jpeg\)$/, "");
  assert.ok(path, "expected a materialized image path");
  assert.match(path, /image-1\.jpg$/);
  assert.deepEqual(readFileSync(path), png);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(text.match(/\[Attached image \(image\/png\)\]/g)?.length, 2);

  const initialize = asRecord(a.wire().find(({ method }) => method === "initialize")?.params);
  assert.deepEqual(initialize?.clientCapabilities, {
    fs: { readTextFile: true },
    elicitation: { form: {} },
  });

  await a.connection.close();
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(dirname(path)), false);
});

for (const behavior of ["allow", "deny"] as const) {
  test(`ACP permission ${behavior} keeps the stall timer paused and maps tool and reasoning events`, async (t) => {
    const a = await attach(fixture(t), { limits: { stallTimeoutMs: 100, idleRuntimeMs: 100, maxTurnMs: 3000 } });
    await a.open();
    await a.connection.send(prompt("permission"));
    const { request } = await a.event("session.permission");
    assert.equal(request.detail?.type, "edit");
    assert.deepEqual(request.actions?.map(({ behavior }) => behavior), ["allow", "deny"]);
    await delay(175);
    assert.equal(a.events.some((event) => event.type === "session.turn" && event.state !== "started"), false);
    assert.equal(a.wire().some(({ method }) => method === "session/cancel"), false);
    assert.equal(a.wire().some(({ type }) => type === "exit"), false);
    await a.connection.send({ type: "session.can_stop_runtime", requestId: "check", sessionId: "s" });
    assert.equal((await a.event("session.can_stop_runtime")).canStop, false);
    const optionId = behavior === "allow" ? "allow_once" : "reject_once";
    await a.connection.send({ type: "session.permission", sessionId: "s", permissionId: request.id,
      response: { behavior, ...(behavior === "allow" ? { selectedActionId: optionId } : {}) } });
    assert.equal((await a.event("session.permission_resolved")).permissionId, request.id);
    await a.event("session.turn", ({ state }) => state === "completed");
    assert.deepEqual(a.wire().find(({ id }) => id === "permission-1")?.result, {
      outcome: { outcome: "selected", optionId },
    });
    assert.ok(a.events.some((event) => event.type === "timeline.item" && event.item.type === "todo"));
    const reason = await a.event("timeline.item", ({ item }) => item.type === "reasoning");
    assert.ok(reason.item.type === "reasoning" && reason.item.text === "planning edit");
    const { item } = await a.event("timeline.item", ({ item }) => item.type === "tool_call" && item.status !== "running");
    assert.ok(item.type === "tool_call" && item.detail.type === "edit");
    assert.equal(item.detail.oldString, "foo");
    assert.equal(item.detail.newString, "bar");
    assert.deepEqual(item.metadata?.locations, [{ path: "/work/a.ts", line: 7 }]);
    assert.equal(item.status, behavior === "allow" ? "completed" : "failed");
  });
}

test("ACP restarts the stall watchdog after the last approval is answered", async (t) => {
  const a = await attach(fixture(t), { limits: { stallTimeoutMs: 150, maxTurnMs: 2000 } });
  await a.open();
  await a.connection.send(prompt("permission-stall"));
  const { request } = await a.event("session.permission");
  await delay(200);
  await a.connection.send({
    type: "session.permission", sessionId: "s", permissionId: request.id, response: { behavior: "allow" },
  });
  assert.equal((await a.event("session.turn", ({ state }) => state === "failed")).error?.code, "TURN_STALLED");
  assert.equal(methods(a.wire()).at(-1), "session/cancel");
});

test("ACP interrupt cancels pending permission first and gracefully reuses a bound session", async (t) => {
  const a = await attach(fixture(t));
  await a.open("s", { persistence: saved("old") });
  await a.connection.send(prompt("permission"));
  await a.event("session.permission");
  await a.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
  await a.event("session.turn", ({ state }) => state === "canceled");
  await a.event("request.completed", ({ requestId }) => requestId === "stop");
  const wire = a.wire();
  const reply = wire.findIndex(({ id }) => id === "permission-1");
  const cancel = wire.findIndex(({ method }) => method === "session/cancel");
  assert.ok(reply >= 0 && reply < cancel);
  assert.deepEqual(wire[reply].result, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(wire[cancel].params, { sessionId: "old" });
  assert.equal(wire.some(({ type }) => type === "SIGINT" || type === "exit"), false);
  assert.equal(a.events.some(({ type }) => type === "session.persistence"), false);
  assert.equal((await a.run("after interrupt")).state, "completed");
  assert.deepEqual(a.wire().filter(({ method }) => method === "session/prompt").map(({ params }) => params?.sessionId), ["old", "old"]);
});

test("ACP elicitation supports choices, free text, custom answers, and pauses the stall watchdog", async (t) => {
  const a = await attach(fixture(t), { limits: { stallTimeoutMs: 120, maxTurnMs: 3000 } });
  await a.open();
  await a.connection.send(prompt("elicitation"));
  const { request } = await a.event("session.permission");
  assert.equal(request.kind, "question");
  assert.equal(request.name, "AskUserQuestion");
  assert.equal(request.title, "Configure the project");
  await delay(175);
  assert.equal(a.events.some((event) => event.type === "session.turn" && event.state !== "started"), false);
  assert.equal(a.wire().some(({ method }) => method === "session/cancel"), false);

  const from = a.events.length;
  await a.connection.send({
    type: "session.permission", sessionId: "s", permissionId: request.id,
    response: {
      behavior: "allow",
      updatedInput: { answers: {
        Color: "Blue",
        Features: "Docs, custom feature",
        Name: "Doubao CLI",
        Framework: "Svelte",
      } },
    },
  });
  assert.equal((await a.event("session.permission_resolved")).permissionId, request.id);
  assert.equal((await a.event("session.turn", ({ state }) => state === "completed", from)).state, "completed");
  assert.deepEqual(a.wire().find(({ id }) => id === "elicitation-1")?.result, {
    action: "accept",
    content: {
      color: "blue",
      features: ["docs"],
      "features:text": "custom feature",
      name: "Doubao CLI",
      "framework:text": "Svelte",
    },
  });
});

test("ACP elicitation deny replies with cancel and interrupt cancels it before the cloud turn", async (t) => {
  const a = await attach(fixture(t));
  await a.open("deny");
  await a.connection.send(prompt("elicitation-deny", "deny"));
  const denied = await a.event("session.permission");
  assert.equal(denied.request.kind, "question");
  await a.connection.send({
    type: "session.permission", sessionId: "deny", permissionId: denied.request.id,
    response: { behavior: "deny" },
  });
  await a.event("session.permission_resolved", ({ permissionId }) => permissionId === denied.request.id);
  await a.event("session.turn", ({ sessionId, state }) => sessionId === "deny" && state === "completed");
  assert.deepEqual(a.wire().find(({ id }) => id === "elicitation-1")?.result, { action: "cancel" });

  await a.open("interrupt");
  await a.connection.send(prompt("elicitation", "interrupt"));
  const pending = await a.event("session.permission", ({ sessionId }) => sessionId === "interrupt");
  await a.connection.send({ type: "session.interrupt", sessionId: "interrupt", requestId: "stop-question" });
  await a.event("session.permission_resolved", ({ sessionId, permissionId }) =>
    sessionId === "interrupt" && permissionId === pending.request.id);
  await a.event("session.turn", ({ sessionId, state }) => sessionId === "interrupt" && state === "canceled");
  await a.event("request.completed", ({ requestId }) => requestId === "stop-question");
  const wire = a.wire();
  const reverse = wire.findIndex(({ id }) => id === "elicitation-1");
  const cancel = wire.findIndex(({ method }) => method === "session/cancel");
  assert.ok(reverse >= 0 && cancel > reverse);
  assert.deepEqual(wire[reverse].result, { action: "cancel" });
});

test("ACP close cancels a live turn before closing its process", async (t) => {
  const a = await attach(fixture(t));
  await a.open();
  await a.connection.send(prompt("wait"));
  await waitUntil(() => a.wire().find(({ method }) => method === "session/prompt"), "prompt receipt");
  await a.connection.send({ type: "session.close", sessionId: "s", requestId: "close" });
  await a.event("session.closed");
  assert.equal((await a.event("session.turn", ({ state }) => state === "canceled")).state, "canceled");
  const wire = a.wire();
  assert.ok(wire.findIndex(({ method }) => method === "session/cancel") < wire.findIndex(({ type }) => type === "exit"));
});

test("ACP escalates only after cloud cancellation grace and kills the whole POSIX process group", {
  skip: process.platform === "win32",
}, async (t) => {
  const a = await attach(fixture(t));
  await a.open("s", { persistence: saved("old") });
  await a.connection.send(prompt("hang"));
  const helper = await waitUntil(() => a.wire().find(({ type }) => type === "helper"), "spawned helper");
  assert.ok(helper.helperPid && alive(helper.helperPid));
  await a.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "force" });
  await waitUntil(() => a.wire().find(({ method }) => method === "session/cancel"), "cloud cancellation");
  assert.ok(alive(helper.pid));
  assert.ok(alive(helper.helperPid));
  await a.event("session.turn", ({ state }) => state === "canceled");
  assert.equal(alive(helper.pid), false);
  await waitUntil(() => !alive(helper.helperPid!), "helper exit");
  assert.deepEqual((await a.event("session.persistence")).persistence, saved(null));
  assert.equal((await a.run("fresh session")).state, "completed");
  assert.equal(a.wire().filter(({ method }) => method === "session/new").length, 1);
});

test("ACP idle reclaim loads a bound session without replay and reapplies selected configuration", async (t) => {
  const a = await attach(fixture(t), { limits: { idleRuntimeMs: 150 } });
  await a.open();
  await a.connection.send({
    type: "session.configure", requestId: "config", sessionId: "s",
    changes: { model: "m2", thinkingOption: "medium", mode: "plan" },
  });
  await a.event("request.completed", ({ requestId }) => requestId === "config");
  assert.equal((await a.run("bind")).state, "completed");
  const first = a.wire().filter(({ method }) => method === "session/prompt").at(-1)!;
  const persisted = await a.event("session.persistence");
  await waitUntil(() => a.wire().some(({ type, pid }) => type === "exit" && pid === first.pid), "idle reaping");
  assert.equal((await a.run("hot resume")).state, "completed");
  const load = a.wire().find(({ method }) => method === "session/load")!;
  assert.notEqual(load.pid, first.pid);
  assert.deepEqual(saved(String(load.params?.sessionId)), persisted.persistence);
  assert.deepEqual(methods(a.wire(), load.pid), [
    "initialize", "session/load", "session/set_mode", "session/set_config_option", "session/set_config_option", "session/prompt",
  ]);
  assert.ok(a.events.some((event) => event.type === "session.config" && event.config.model === "m2" &&
    event.config.thinkingOption === "medium" && event.config.mode === "plan"));
  assert.equal(a.events.filter(({ type }) => type === "session.persistence").length, 1);
  assert.ok(!a.events.some((event) => event.type === "timeline.item" && event.item.type === "assistant_message" &&
    event.item.text === "previous answer"));
});

test("ACP idle reclaim replaces an unbound zero-turn session when configured", async (t) => {
  const a = await attach(fixture(t), { limits: { idleRuntimeMs: 80 } });
  await a.open();
  await waitUntil(() => a.wire().some(({ type }) => type === "exit"), "zero-turn idle exit");
  await a.connection.send({ type: "session.configure", requestId: "after-idle", sessionId: "s", changes: { mode: "plan" } });
  await a.event("request.completed", ({ requestId }) => requestId === "after-idle");
  assert.equal(a.wire().filter(({ method }) => method === "session/new").length, 2);
  assert.ok(!methods(a.wire()).includes("session/load"));
  assert.equal((await a.event("session.config", ({ config }) => config.mode === "plan")).config.mode, "plan");
  assert.ok(!a.events.some(({ type }) => type === "session.persistence"));
});

test("ACP startup restore skips an unavailable effort option and accepts the server value", async (t) => {
  const a = await attach(fixture(t, { FAKE_FIXED_EFFORT: "1" }), { limits: { idleRuntimeMs: 100 } });
  await a.open();
  await a.connection.send({
    type: "session.configure", requestId: "switch-fixed", sessionId: "s",
    changes: { model: "m2" },
  });
  await a.event("request.completed", ({ requestId }) => requestId === "switch-fixed");
  assert.equal((await a.run("bind fixed")).state, "completed");
  const first = a.wire().filter(({ method }) => method === "session/prompt").at(-1)!;
  await waitUntil(() => a.wire().some(({ type, pid }) => type === "exit" && pid === first.pid), "idle exit");
  const beforeRestore = a.wire().length;
  assert.equal((await a.run("restore fixed")).state, "completed");
  const restored = a.wire().slice(beforeRestore);
  assert.ok(!restored.some(({ method, params }) =>
    method === "session/set_config_option" && params?.configId === "effort"));
  await a.connection.send({ type: "session.configure", requestId: "restore-fixed", sessionId: "s",
    changes: { thinkingOption: "high" } });
  assert.equal((await a.event("request.failed")).error.code, "DOUBAO_INVALID_ARGUMENTS");
  const config = await a.event("session.config", ({ config }) => config.model === "m2");
  assert.equal(config.config.thinkingOption, undefined);
  assert.equal((await a.run("fixed effort")).state, "completed");
});

test("ACP startup restore skips an effort value absent from the model's choices", async (t) => {
  const a = await attach(fixture(t), { limits: { idleRuntimeMs: 100 } });
  await a.open();
  await a.connection.send({ type: "session.configure", requestId: "model-2", sessionId: "s",
    changes: { model: "m2" } });
  await a.event("request.completed", ({ requestId }) => requestId === "model-2");
  assert.equal((await a.run("bind model 2")).state, "completed");
  const first = a.wire().find(({ method }) => method === "session/prompt")!;
  await waitUntil(() => a.wire().some(({ type, pid }) => type === "exit" && pid === first.pid), "idle exit");
  const before = a.wire().length;
  assert.equal((await a.run("resume model 2")).state, "completed");
  const resumed = a.wire().slice(before);
  assert.ok(!resumed.some(({ method, params }) =>
    method === "session/set_config_option" && params?.configId === "effort"));
  assert.ok(a.events.some((event) => event.type === "session.config" &&
    event.config.model === "m2" && event.config.thinkingOption === "max"));
});

test("ACP first prompt after zero-turn idle reclaim creates a new native session", async (t) => {
  const a = await attach(fixture(t), { limits: { idleRuntimeMs: 80 } });
  await a.open();
  await waitUntil(() => a.wire().some(({ type }) => type === "exit"), "zero-turn idle exit");
  assert.equal((await a.run("first prompt")).state, "completed");
  const sessions = a.wire().filter(({ method }) => method === "session/new");
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].pid, sessions[1].pid);
  assert.ok(!methods(a.wire()).includes("session/load"));
  await a.event("session.persistence");
});

test("ACP falls back and warns when a bound session disappears before hot reload", async (t) => {
  const a = await attach(fixture(t), { limits: { idleRuntimeMs: 80 } });
  await a.open();
  assert.equal((await a.run("bind")).state, "completed");
  const first = a.wire().find(({ method }) => method === "session/prompt")!;
  await waitUntil(() => a.wire().some(({ type, pid }) => type === "exit" && pid === first.pid), "idle exit");
  rmSync(join(a.dir, `bound-${first.params?.sessionId}`));
  assert.equal((await a.run("new after lost")).state, "completed");
  assert.deepEqual((await a.event("session.persistence", ({ persistence }) => persistence.data != null &&
    JSON.stringify(persistence.data) === '{"sessionId":null}')).persistence, saved(null));
  assert.equal((await a.event("session.notice")).notice.severity, "warning");
  const load = a.wire().find(({ method }) => method === "session/load")!;
  assert.deepEqual(methods(a.wire(), load.pid), ["initialize", "session/load", "session/new", "session/prompt"]);
});

test("ACP cloud errors preserve ID for login and busy, and invalidate it on not_found", async (t) => {
  const a = await attach(fixture(t));
  await a.open("s", { persistence: saved("old") });
  for (const [scenario, code] of [["login", "DOUBAO_LOGIN_REQUIRED"], ["busy", "DOUBAO_SESSION_BUSY"]]) {
    const failure = await a.run(scenario);
    assert.equal(failure.error?.code, code);
    assert.equal(a.events.some(({ type }) => type === "session.persistence"), false);
  }
  assert.equal((await a.run("rpc-canceled")).state, "canceled");
  const lost = await a.run("missing");
  assert.equal(lost.error?.code, "DOUBAO_SESSION_NOT_FOUND");
  assert.deepEqual((await a.event("session.persistence")).persistence, saved(null));
  assert.equal((await a.run("after not found")).state, "completed");
  const prompts = a.wire().filter(({ method }) => method === "session/prompt");
  assert.ok(prompts.slice(0, -1).every(({ params }) => params?.sessionId === "old"));
  assert.notEqual(prompts.at(-1)?.params?.sessionId, "old");
});

test("ACP startup login_required never falls back or clears the persisted ID", async (t) => {
  const a = await attach(fixture(t));
  await a.connection.send({
    type: "session.open", sessionId: "s", requestId: "login", history: "skip", persistence: saved("needs-login"),
    config: { cwd: a.dir, env: {}, settings: {}, mcpServers: {}, persist: true },
  });
  assert.equal((await a.event("request.failed")).error.code, "DOUBAO_LOGIN_REQUIRED");
  assert.ok(!methods(a.wire()).includes("session/new"));
  assert.ok(!a.events.some(({ type }) => type === "session.persistence"));
});

test("ACP runtime crash surfaces buffered stderr in turn and runtime failures, then reloads the saved ID", async (t) => {
  const a = await attach(fixture(t));
  await a.open("s", { persistence: saved("old") });
  const failed = await a.run("crash");
  assert.equal(failed.error?.code, "ACP_RUNTIME_EXIT");
  assert.match(failed.error?.message ?? "", /\[cli-chat\] cloud transport closed 中文/);
  const runtimeFailure = await a.event("session.runtime_failed");
  assert.match(runtimeFailure.error.message, /cloud transport closed 中文/);
  assert.ok(a.events.indexOf(failed) < a.events.indexOf(runtimeFailure));
  assert.equal(a.events.some(({ type }) => type === "session.persistence"), false);
  assert.equal((await a.run("recover")).state, "completed");
  assert.equal(a.wire().filter(({ method }) => method === "session/load").length, 2);
});

test("ACP stderr activity refreshes the stall watchdog", async (t) => {
  const a = await attach(fixture(t), { limits: { stallTimeoutMs: 120, maxTurnMs: 2000 } });
  await a.open();
  assert.equal((await a.run("stderr-heartbeat")).state, "completed");
  assert.equal(a.events.some((event) => event.type === "session.turn" && event.state === "failed"), false);
});

test("ACP interrupt before the disk check emits no phantom turn events", async (t) => {
  const a = await attach(fixture(t), { limits: { minFreeDiskBytes: 1 } });
  await a.open();
  await a.connection.send(prompt("cancel before disk"));
  await a.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "cancel" });
  await a.event("request.completed", ({ requestId }) => requestId === "cancel");
  const { result } = await a.event("session.prompt_result");
  assert.equal(result.type, "failed");
  assert.equal(result.error.code, "DOUBAO_REQUEST_CANCELLED");
  assert.equal(a.events.some((event) =>
    event.type === "timeline.item" && event.item.type === "user_message"), false);
  assert.equal(a.events.some((event) =>
    event.type === "session.turn" && event.state === "started"), false);
});

test("ACP session close before the disk check emits no phantom turn events", async (t) => {
  const a = await attach(fixture(t), { limits: { minFreeDiskBytes: 1 } });
  await a.open();
  await a.connection.send(prompt("close before disk"));
  await a.connection.send({ type: "session.close", sessionId: "s", requestId: "close-before" });
  await a.event("session.closed");
  assert.equal(a.events.some((event) =>
    event.type === "timeline.item" && event.item.type === "user_message"), false);
  assert.equal(a.events.some((event) =>
    event.type === "session.turn" && event.state === "started"), false);
});

for (const [scenario, code, diagnostic] of [
  ["FAKE_START_CRASH", "ACP_RUNTIME_EXIT", "startup diagnostic"],
  ["FAKE_INITIALIZE_HANG", "ACP_REQUEST_TIMEOUT", "connection to Doubao timed out"],
] as const) {
  test(`ACP startup surfaces stderr for ${code} and cleans up the process`, async (t) => {
    const a = await attach(fixture(t, { [scenario]: "1" }), { startupTimeoutMs: 250 });
    await a.connection.send({
      type: "session.open", sessionId: "s", requestId: "fail", history: "skip",
      config: { cwd: a.dir, env: {}, settings: {}, mcpServers: {}, persist: true },
    });
    const result = await a.event("request.failed");
    assert.equal(result.error.code, code);
    assert.ok(result.error.message.includes(diagnostic));
    assert.ok(a.wire().some(({ type }) => type === "exit"));
  });
}

test("ACP list has a deadline and closes its probe", async (t) => {
  const a = await attach(fixture(t, { FAKE_LIST_HANG: "1" }), { startupTimeoutMs: 250 });
  await a.connection.send({ type: "sessions", requestId: "list", cwd: a.dir });
  assert.equal((await a.event("request.failed")).error.code, "ACP_REQUEST_TIMEOUT");
  assert.ok(a.wire().some(({ type }) => type === "exit"));
});

test("ACP cancels an in-flight session list and cleans up the probe", async (t) => {
  const a = await attach(fixture(t, { FAKE_LIST_HANG: "1" }));
  await a.connection.send({ type: "sessions", requestId: "cancel-list", cwd: a.dir });
  await waitUntil(() => a.wire().find(({ method }) => method === "session/list"), "listing probe");
  if (a.connection.capabilities.includes("request.cancel")) {
    // Compile this test with the 0.15 types, which predate the negotiated input.
    await a.connection.send({ type: "request.cancel", requestId: "cancel-list" } as unknown as ProviderInput);
  } else {
    await a.connection.close();
  }
  await waitUntil(() => a.wire().some(({ type }) => type === "exit"), "listing probe exit");
  assert.ok(!a.events.some(({ type }) => type === "sessions" || type === "request.failed"));
});

test("ACP request.cancel aborts an in-flight catalog model probe", async (t) => {
  const a = await attach(fixture(t, { FAKE_MODEL_HANG: "1" }));
  if (!a.connection.capabilities.includes("request.cancel")) {
    t.skip("Paseo SDK does not advertise request.cancel");
    return;
  }
  await a.connection.send({ type: "catalog", requestId: "cancel-catalog", cwd: a.dir });
  const probe = await waitUntil(() => a.wire().find(({ args }) =>
    args?.join(" ") === "model list --output-format json"), "catalog probe");
  await a.connection.send({
    type: "request.cancel",
    requestId: "cancel-catalog",
  } as unknown as ProviderInput);
  await waitUntil(() => a.wire().some(({ type, pid }) =>
    type === "catalog_aborted" && pid === probe.pid), "catalog cancellation");
  assert.equal(a.events.some(({ type }) => type === "catalog" || type === "request.failed"), false);
});

test("ACP shares the global turn cap with other connections and stream-json", async (t) => {
  const first = await attach(fixture(t), { limits: { maxConcurrentTurns: 1 } });
  const second = await attach(fixture(t), { limits: { maxConcurrentTurns: 1 } });
  const stream = await createDoubaoProvider({ transport: "stream-json", limits: { maxConcurrentTurns: 1 } }).connect({
    versions: [1], capabilities: ["prompt.message"], launch: first.launch,
  });
  t.after(() => stream.close());
  const streamEvents: ProviderEvent[] = [];
  stream.onEvent((event) => streamEvents.push(event));
  await first.open();
  await second.open();
  await stream.send({
    type: "session.open", requestId: "stream", sessionId: "s", history: "skip",
    config: { cwd: first.dir, env: {}, settings: {}, mcpServers: {}, persist: false },
  });
  await first.connection.send(prompt("wait"));
  await waitUntil(() => first.wire().find(({ method }) => method === "session/prompt"), "first turn");
  await second.connection.send(prompt("second"));
  const denied = await second.event("session.prompt_result", ({ result }) => result.type === "failed");
  assert.ok(denied.result.type === "failed" && denied.result.error.code === "TOO_MANY_TURNS");
  await stream.send(prompt("stream"));
  const streamDenied = await waitUntil(() => streamEvents.find((event): event is Event<"session.prompt_result"> =>
    event.type === "session.prompt_result"), "stream rejection");
  assert.ok(streamDenied.result.type === "failed" && streamDenied.result.error.code === "TOO_MANY_TURNS");
  await first.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "release" });
  await first.event("request.completed", ({ requestId }) => requestId === "release");
  assert.equal((await second.run("after release")).state, "completed");
});

test("ACP serializes turn admission and refuses configuration while a turn is active", async (t) => {
  const a = await attach(fixture(t), { limits: { maxConcurrentTurns: 0 } });
  await a.open();
  await a.connection.send(prompt("wait"));
  await a.connection.send(prompt("duplicate"));
  const rejected = await a.event("session.prompt_result", ({ clientMessageId }) => clientMessageId === "duplicate");
  assert.ok(rejected.result.type === "failed" && rejected.result.error.code === "DOUBAO_SESSION_BUSY");
  await a.connection.send({ type: "session.configure", sessionId: "s", requestId: "busy-cfg", changes: { model: "m2" } });
  assert.equal((await a.event("request.failed")).error.code, "DOUBAO_SESSION_BUSY");
  await a.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "done" });
  await a.event("request.completed", ({ requestId }) => requestId === "done");
});

for (const [limits, expectedCode] of [
  [{ maxTurnMs: 100, stallTimeoutMs: 0 }, "TURN_TIMEOUT"],
  [{ maxTurnMs: 2000, stallTimeoutMs: 100 }, "TURN_STALLED"],
] as const) {
  test(`ACP ${expectedCode} asks Doubao to cancel gracefully and preserves persistence`, async (t) => {
    const a = await attach(fixture(t), { limits });
    await a.open("s", { persistence: saved("old") });
    assert.equal((await a.run("wait")).error?.code, expectedCode);
    assert.equal(methods(a.wire()).at(-1), "session/cancel");
    assert.ok(!a.events.some(({ type }) => type === "session.persistence"));
    assert.ok(!a.wire().some(({ type }) => type === "SIGINT" || type === "exit"));
  });
}

test("ACP enforces maxTurnMs even while a permission is pending", async (t) => {
  const a = await attach(fixture(t), { limits: { maxTurnMs: 220, stallTimeoutMs: 100 } });
  await a.open();
  await a.connection.send(prompt("permission"));
  await a.event("session.permission");
  assert.equal((await a.event("session.turn", ({ state }) => state === "failed")).error?.code, "TURN_TIMEOUT");
  assert.deepEqual(a.wire().find(({ id }) => id === "permission-1")?.result, { outcome: { outcome: "cancelled" } });
});

test("ACP assistant and reasoning output use one UTF-8-safe budget per turn", async (t) => {
  const a = await attach(fixture(t), { limits: { maxAssistantBytes: 5 } });
  await a.open();
  for (const [scenario, kind] of [["utf-assistant", "assistant_message"], ["utf-reasoning", "reasoning"], ["utf-shared", "assistant_message"]]) {
    const from = a.events.length;
    await a.run(scenario);
    const { item } = await a.event("timeline.item", ({ item }) => item.type === kind, from);
    assert.ok(item.type === "assistant_message" || item.type === "reasoning");
    assert.equal(item.text, scenario === "utf-shared" ? "\n[truncated]" : "中\n[truncated]");
  }
});

test("ACP refuses prompts above byte or code point limits and checks free disk before submission", async (t) => {
  const bytes = await attach(fixture(t), { limits: { maxPromptBytes: 4 } });
  await bytes.open();
  await bytes.connection.send(prompt("中中"));
  const rejected = await bytes.event("session.prompt_result");
  assert.ok(rejected.result.type === "failed" && rejected.result.error.code === "PROMPT_TOO_LARGE");
  assert.match(rejected.result.error.message, /6 bytes/);
  const long = "a".repeat(262_145);
  const oversized = bytes.event("session.prompt_result", ({ clientMessageId }) => clientMessageId === long);
  await bytes.connection.send(prompt(long));
  const codepoints = await oversized;
  assert.ok(codepoints.result.type === "failed");
  assert.match(codepoints.result.error.message, /262145 code points/);
  assert.ok(!methods(bytes.wire()).includes("session/prompt"));

  const disk = await attach(fixture(t), { limits: { minFreeDiskBytes: Number.MAX_SAFE_INTEGER } });
  await disk.open();
  await disk.connection.send(prompt("low disk"));
  const diskResult = await disk.event("session.prompt_result");
  assert.ok(diskResult.result.type === "failed" && diskResult.result.error.code === "DISK_LOW");
  assert.ok(!methods(disk.wire()).includes("session/prompt"));
});

test("ACP mode and config option notifications update the provider state", async (t) => {
  const a = await attach(fixture(t));
  await a.open();
  await a.run("config-notify");
  const { config } = await a.event("session.config", ({ config }) => config.mode === "plan" && config.thinkingOption === "low");
  assert.equal(config.model, "m1");
});
