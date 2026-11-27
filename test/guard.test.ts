import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../server/cli.js";

function fakeReal(): string {
  const dir = mkdtempSync(join(tmpdir(), "doubao-real-"));
  const command = join(dir, "doubao-real");
  writeFileSync(command, '#!/bin/sh\necho "REAL:$@"\n');
  chmodSync(command, 0o755);
  return command;
}

function run(command: string, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));
    child.once("close", (code) => resolve({ code, out, err }));
  });
}

test("the guard directory is prepended to PATH", () => {
  const env = childEnv({ PATH: "/usr/bin:/bin" }, "/bin/true");
  assert.ok(env.PATH.startsWith(join(tmpdir(), "paseo-doubao-guard-")));
  assert.ok(env.PATH.endsWith("/usr/bin:/bin"));
});

test("a nested turn is blocked before it can deadlock the session", async () => {
  const env = childEnv({ PATH: "/usr/bin:/bin" }, fakeReal());
  const result = await run('doubao -p "hi"', env);

  assert.equal(result.code, 64);
  assert.match(result.err, /nested turn invocation is blocked/);
  assert.equal(result.out, "");
});

test("introspection commands still reach the real binary", async () => {
  const env = childEnv({ PATH: "/usr/bin:/bin" }, fakeReal());

  const version = await run("doubao --version", env);
  assert.equal(version.code, 0);
  assert.equal(version.out.trim(), "REAL:--version");

  const modelList = await run("doubao model list --output-format json", env);
  assert.equal(modelList.code, 0);
  assert.equal(modelList.out.trim(), "REAL:model list --output-format json");
});

test("DOUBAO_PASEO_ALLOW_NESTED=1 disables the guard", () => {
  process.env.DOUBAO_PASEO_ALLOW_NESTED = "1";
  try {
    const env = childEnv({ PATH: "/usr/bin:/bin" }, "/bin/true");
    assert.equal(env.PATH, "/usr/bin:/bin");
  } finally {
    delete process.env.DOUBAO_PASEO_ALLOW_NESTED;
  }
});
