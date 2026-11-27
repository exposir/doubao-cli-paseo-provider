import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODES,
  catalogCacheKey,
  fallbackCatalog,
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
