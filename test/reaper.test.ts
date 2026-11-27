import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { CHILD_ENV_KEY, childEnv, reapStaleChildren } from "../server/cli.js";

function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("childEnv adds the marker without dropping launch variables", () => {
  const env = childEnv({ A: "1", B: undefined });
  assert.equal(env.A, "1");
  assert.ok(env[CHILD_ENV_KEY]?.startsWith("paseo-"));
  assert.equal("B" in env, false);
});

test("orphans carrying the marker are reaped, unrelated processes are not", async () => {
  const marker = `test-${randomUUID()}`;
  const marked = spawn("sleep", ["30"], {
    env: { ...process.env, [CHILD_ENV_KEY]: marker },
    stdio: "ignore",
  });
  const other = spawn("sleep", ["30"], { env: { ...process.env }, stdio: "ignore" });

  assert.ok(marked.pid && other.pid);

  try {
    const killed = reapStaleChildren(marker);
    assert.ok(killed >= 1, `expected at least one process, got ${killed}`);

    const code = await waitForExit(marked);
    assert.equal(code, null, "the marked process should have been signalled");

    assert.equal(other.exitCode, null, "an unrelated process must survive");
  } finally {
    marked.kill("SIGKILL");
    other.kill("SIGKILL");
  }
});
