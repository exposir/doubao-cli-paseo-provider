import { test } from "node:test";
import assert from "node:assert/strict";
import { execJson } from "../server/cli.js";
import { parseModels } from "../server/catalog.js";

const LIVE = process.env.DOUBAO_LIVE === "1";

/**
 * These hit the real CLI and need a logged-in account. Run with:
 *   npm run test:live
 */
test("live: doubao model list returns a catalogue", { skip: !LIVE }, async () => {
  const payload = await execJson(
    { command: "doubao", args: [], env: env() },
    ["model", "list", "--output-format", "json"],
    { timeoutMs: 30_000 },
  );

  const models = parseModels(payload);
  assert.ok(models.length > 0, "expected at least one model");
  assert.ok(models.some((model) => model.id.length > 0));
});

test("live: doubao --list returns sessions in JSON form", { skip: !LIVE }, async () => {
  const payload = await execJson(
    { command: "doubao", args: [], env: env() },
    ["--list", "--output-format", "json", "--limit", "1"],
    { timeoutMs: 30_000 },
  );

  assert.equal(payload?.type, "result");
  assert.ok(payload?.result);
});

function env(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
