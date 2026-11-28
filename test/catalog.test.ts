import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  MODES,
  buildCatalog,
  catalogCacheKey,
  clearCatalogCache,
  fallbackCatalog,
  loadCatalog,
  parseModels,
} from "../server/catalog.js";

const payload = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: {
    type: "model_list",
    models: [
      { id: "9", name: "Auto", is_default: false, efforts: ["low", "high"], default_effort: "high" },
      { id: "m1", name: "Model One", is_default: true, efforts: ["low", "max"], default_effort: "max" },
    ],
  },
};

test("parseModels maps ids, labels, defaults and per-model effort levels", () => {
  const models = parseModels(payload);
  assert.equal(models.length, 2);

  assert.equal(models[0].id, "9");
  assert.equal(models[0].label, "Auto");
  assert.equal(models[0].isDefault, false);
  assert.deepEqual(
    models[0].thinkingOptions?.map((option) => [option.id, option.isDefault]),
    [
      ["low", false],
      ["high", true],
    ],
  );

  assert.equal(models[1].id, "m1");
  assert.equal(models[1].isDefault, true);
  assert.equal(models[1].defaultThinkingOptionId, "max");
});

test("parseModels ignores malformed entries", () => {
  const models = parseModels({
    result: {
      models: [
        { name: "no id" },
        { id: "" },
        { id: "ok", name: "OK" },
        null,
        "nope",
      ],
    },
  });
  assert.deepEqual(models.map((model) => model.id), ["ok"]);
});

test("parseModels tolerates a missing payload", () => {
  assert.deepEqual(parseModels(null), []);
  assert.deepEqual(parseModels({ result: {} }), []);
});

test("fallback catalogue exposes the three CLI permission modes", () => {
  const catalog = fallbackCatalog();
  assert.deepEqual(catalog.models, []);
  assert.deepEqual(
    catalog.modes.map((mode) => mode.id),
    ["ask_risky", "ask_always", "always_allow"],
  );
  assert.equal(catalog.defaultMode, "ask_risky");
  assert.equal(MODES.length, 3);
});

test("catalogCacheKey is stable and separates environments", () => {
  const base = { command: "doubao", args: [], env: { A: "1", B: "2" } };
  assert.equal(catalogCacheKey(base), catalogCacheKey({ ...base, env: { B: "2", A: "1" } }));
  assert.notEqual(catalogCacheKey(base), catalogCacheKey({ ...base, env: { A: "1", B: "3" } }));
});

test("buildCatalog uses the default model and its default effort", () => {
  const catalog = buildCatalog(payload);
  assert.equal(catalog.defaultModel, "m1");
  assert.equal(catalog.defaultThinkingOption, "max");
  assert.deepEqual(
    catalog.thinkingOptions?.map((option) => option.id),
    ["low", "high", "max"],
  );
  assert.equal(catalog.defaultMode, "ask_risky");
});

test("buildCatalog falls back when the payload has no usable models", () => {
  const catalog = buildCatalog({ result: { models: [] } });
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.defaultModel, undefined);
  assert.deepEqual(
    catalog.modes.map((mode) => mode.id),
    ["ask_risky", "ask_always", "always_allow"],
  );
});

test("buildCatalog keeps the first default when several models claim it", () => {
  const catalog = buildCatalog({
    result: {
      models: [
        { id: "a", name: "A", is_default: true },
        { id: "b", name: "B", is_default: true },
      ],
    },
  });
  assert.equal(catalog.defaultModel, "a");
});

test("duplicate model ids are collapsed to the first entry", () => {
  const models = parseModels({
    result: {
      models: [
        { id: "dup", name: "First" },
        { id: "dup", name: "Second" },
      ],
    },
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].label, "First");
});

test("effort lists filter non-string values", () => {
  const models = parseModels({
    result: { models: [{ id: "m", name: "M", efforts: ["low", 3, null, "max"] }] },
  });
  assert.deepEqual(
    models[0].thinkingOptions?.map((option) => option.id),
    ["low", "max"],
  );
});

test("a model without a name falls back to its id as label", () => {
  const models = parseModels({ result: { models: [{ id: "only-id" }] } });
  assert.equal(models[0].label, "only-id");
});

test("buildCatalog falls back to the first effort when the default model has none", () => {
  const catalog = buildCatalog({
    result: {
      models: [
        { id: "a", name: "A", is_default: true, efforts: ["low"] },
        { id: "b", name: "B", efforts: ["max"] },
      ],
    },
  });
  assert.equal(catalog.defaultModel, "a");
  assert.equal(catalog.defaultThinkingOption, "low");
});

function countingCli(): { launch: ProviderLaunch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "doubao-catalog-"));
  const command = join(dir, "doubao");
  writeFileSync(
    command,
    `#!/usr/bin/env bash
printf 'call\\n' >> "${dir}/calls"
if [ -f "${dir}/fail" ]; then exit 1; fi
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"model_list","models":[{"id":"m1","name":"Model One","is_default":true,"efforts":["low","high"],"default_effort":"high"}]}}'
`,
  );
  chmodSync(command, 0o755);
  return { launch: { command, args: [], env: {} }, dir };
}

function callCount(dir: string): number {
  const path = join(dir, "calls");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
}

function slowCli(delaySeconds: string): { launch: ProviderLaunch; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "doubao-catalog-slow-"));
  const command = join(dir, "doubao.mjs");
  writeFileSync(
    command,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = ${JSON.stringify(dir)};
appendFileSync(join(dir, "calls"), "call\\n");
process.once("SIGTERM", () => {
  writeFileSync(join(dir, "aborted"), "");
  process.exit(130);
});
setTimeout(() => {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: {
    type: "model_list",
    models: [{ id: "m1", name: "Model One", is_default: true }],
  } }));
}, existsSync(join(dir, "aborted")) ? 0 : ${Number(delaySeconds) * 1000});
`,
  );
  chmodSync(command, 0o755);
  return { launch: { command: process.execPath, args: [command], env: {} }, dir };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out");
}

test("loadCatalog caches within the TTL", async () => {
  clearCatalogCache();
  const { launch, dir } = countingCli();

  const first = await loadCatalog(launch);
  const second = await loadCatalog(launch);

  assert.equal(first.models[0].id, "m1");
  assert.equal(second.models[0].id, "m1");
  assert.equal(callCount(dir), 1);
});

test("loadCatalog re-probes when the TTL is zero or force is set", async () => {
  clearCatalogCache();
  const { launch, dir } = countingCli();

  await loadCatalog(launch, { ttlMs: 0 });
  await loadCatalog(launch, { ttlMs: 0 });
  assert.equal(callCount(dir), 2);

  await loadCatalog(launch, { force: true });
  assert.equal(callCount(dir), 3);
});

test("loadCatalog falls back when the CLI fails", async () => {
  clearCatalogCache();
  const { launch, dir } = countingCli();
  writeFileSync(join(dir, "fail"), "1");

  const catalog = await loadCatalog(launch);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.defaultMode, "ask_risky");
  assert.equal(callCount(dir), 1);
});

test("concurrent loadCatalog calls share one probe", async () => {
  clearCatalogCache();
  const { launch, dir } = countingCli();

  const [a, b] = await Promise.all([loadCatalog(launch), loadCatalog(launch)]);
  assert.equal(a.models[0].id, "m1");
  assert.equal(b.models[0].id, "m1");
  assert.equal(callCount(dir), 1);
});

test("one canceled catalog waiter does not abort a shared probe", async () => {
  clearCatalogCache();
  const { launch, dir } = slowCli("0.3");
  const canceled = new AbortController();
  const surviving = new AbortController();

  const first = loadCatalog(launch, { signal: canceled.signal });
  const second = loadCatalog(launch, { signal: surviving.signal });
  await waitUntil(() => callCount(dir) === 1);
  canceled.abort(new Error("caller canceled"));

  await assert.rejects(first, /caller canceled/);
  const catalog = await second;
  assert.equal(catalog.models[0].id, "m1");
  assert.equal(callCount(dir), 1);
});

test("all canceled catalog waiters abort the shared CLI probe", async () => {
  clearCatalogCache();
  const { launch, dir } = slowCli("5");
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = loadCatalog(launch, { signal: firstController.signal });
  const second = loadCatalog(launch, { signal: secondController.signal });
  await waitUntil(() => callCount(dir) === 1);
  firstController.abort(new Error("first canceled"));
  secondController.abort(new Error("second canceled"));

  await assert.rejects(first, /first canceled/);
  await assert.rejects(second, /second canceled/);
  await waitUntil(() => existsSync(join(dir, "aborted")), 5000);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const recovered = await loadCatalog(launch);
  assert.equal(recovered.models[0].id, "m1");
  assert.equal(callCount(dir), 2);
});

test("loadCatalog does not cache an empty model list from a transient response", async () => {
  clearCatalogCache();
  const dir = mkdtempSync(join(tmpdir(), "doubao-catalog-empty-"));
  const command = join(dir, "doubao");
  writeFileSync(
    command,
    `#!/usr/bin/env bash
printf 'call\\n' >> "${dir}/calls"
if [ ! -f "${dir}/ready" ]; then
  touch "${dir}/ready"
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"model_list","models":[]}}'
  exit 0
fi
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":{"type":"model_list","models":[{"id":"m1","name":"Model One","is_default":true}]}}'
`,
  );
  chmodSync(command, 0o755);
  const launch: ProviderLaunch = { command, args: [], env: {} };

  const first = await loadCatalog(launch);
  assert.deepEqual(first.models, []);

  const second = await loadCatalog(launch);
  assert.equal(second.models.length, 1);
  assert.equal(second.models[0].id, "m1");
  assert.equal(callCount(dir), 2);
});
