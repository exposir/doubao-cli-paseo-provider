import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  CHILD_ENV_KEY,
  childEnv,
  reapStaleChildren,
  spawnTurn,
  stopProcess,
} from "../server/cli.js";

function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("childEnv adds the marker and disables CLI update checks without dropping launch variables", () => {
  const env = childEnv({ A: "1", B: undefined });
  assert.equal(env.A, "1");
  assert.equal(env.DOUBAO_CLI_NO_UPDATE_CHECK, "1");
  assert.ok(env[CHILD_ENV_KEY]?.startsWith("paseo-"));
  assert.equal("B" in env, false);
});

test("orphans carrying the marker are reaped, unrelated processes are not", async () => {
  const marker = `test-${randomUUID()}`;
  // Spawn node (not /bin/sleep, whose env is hidden by macOS SIP) so this works on Linux and macOS.
  const marked = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    env: { ...process.env, [CHILD_ENV_KEY]: marker },
    stdio: "ignore",
  });
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    env: { ...process.env },
    stdio: "ignore",
  });

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

test("a startup sweep leaves marked children of a live provider alone", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
  const marker = `test-${randomUUID()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    env: { ...childEnv(process.env), [CHILD_ENV_KEY]: marker },
    stdio: "ignore",
  });
  try {
    assert.ok(child.pid);
    assert.equal(reapStaleChildren(marker), 0);
    assert.equal(isAlive(child.pid), true);
  } finally {
    const stopped = waitForExit(child);
    child.kill("SIGKILL");
    await stopped;
  }
});

test("stopProcess terminates the child and its spawned subprocess group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doubao-pgroup-"));
  const launcher = join(dir, "launcher");
  const pidFile = join(dir, "grandchild.pid");
  writeFileSync(
    launcher,
    `#!/usr/bin/env bash
"${process.execPath}" -e "setTimeout(() => {}, 30000)" &
echo $! > "${pidFile}"
wait
`,
  );
  chmodSync(launcher, 0o755);

  const child = spawnTurn({ command: launcher, args: [], env: {} }, [], dir, "hello");
  const deadline = Date.now() + 3000;
  let grandchildPid = 0;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(pidFile, "utf8").trim();
      if (raw) {
        grandchildPid = Number(raw);
        break;
      }
    } catch {
      // Waiting for launcher to write grandchild pid.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(grandchildPid > 0, "grandchild should have started");

  try {
    await stopProcess(child, 500);
    await waitForExit(child);
    // Allow brief kernel cleanup after process group signal.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isAlive(grandchildPid), false, "grandchild should be terminated with the group");
  } finally {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }
});
