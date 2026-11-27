import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

/** Discovery commands must never be able to hang the provider catalogue. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Every child inherits this marker. A daemon that is SIGKILLed cannot run exit
 * hooks, so the next start scans /proc for the marker and cleans up instead.
 */
export const CHILD_ENV_KEY = "PASEO_DOUBAO_CHILD";
const CHILD_MARKER = `paseo-${createHash("sha256")
  .update(process.env.PASEO_HOME ?? "default")
  .digest("hex")
  .slice(0, 12)}`;

const guardDir = join(
  tmpdir(),
  `paseo-doubao-guard-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
);
let guardReady = false;

export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  realCommand = "/usr/local/bin/doubao",
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  merged[CHILD_ENV_KEY] = CHILD_MARKER;
  merged.DOUBAO_PASEO_REAL_BIN = realCommand;

  if (process.env.DOUBAO_PASEO_ALLOW_NESTED !== "1") {
    // The CLI's sandbox rebuilds PATH, so a PATH shim alone is not reliable.
    // An exported bash function shadows the command regardless of PATH order.
    merged["BASH_FUNC_doubao%%"] =
      '() { for arg in "$@"; do case "$arg" in -p|--resume) ' +
      'echo "doubao: nested turn invocation is blocked by the Paseo provider." >&2; ' +
      'echo "doubao: set DOUBAO_PASEO_ALLOW_NESTED=1 before starting the daemon to allow it." >&2; ' +
      'return 64;; esac; done; ' +
      'command "${DOUBAO_PASEO_REAL_BIN:-/usr/local/bin/doubao}" "$@"; }';

    const guard = ensureNestedGuard();
    if (guard) {
      const path =
        merged.PATH ??
        process.env.PATH ??
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
      merged.PATH = `${guard}:${path}`;
    }
  }

  return merged;
}

/**
 * `doubao` inside a turn's tool shell would attach to the same conversation and
 * deadlock the active turn. A shim on PATH fails those calls fast while leaving
 * introspection (`--help`, `model list`, `--list`) working.
 */
function ensureNestedGuard(): string {
  if (guardReady) return guardDir;
  try {
    mkdirSync(guardDir, { recursive: true });
    const shim = join(guardDir, "doubao");
    writeFileSync(
      shim,
      `#!/bin/sh
real="\${DOUBAO_PASEO_REAL_BIN:-/usr/local/bin/doubao}"
for arg in "$@"; do
  case "$arg" in
    -p|--resume)
      echo "doubao: nested turn invocation is blocked by the Paseo provider." >&2
      echo "doubao: set DOUBAO_PASEO_ALLOW_NESTED=1 before starting the daemon to allow it." >&2
      exit 64
      ;;
  esac
done
exec "$real" "$@"
`,
    );
    chmodSync(shim, 0o755);
    guardReady = true;
    return guardDir;
  } catch {
    return "";
  }
}

/**
 * Kill processes left behind by a previous daemon instance. Only processes that
 * carry this home's marker are touched, so a manual `doubao` session survives.
 */
export function reapStaleChildren(marker: string = CHILD_MARKER): number {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return 0;
  }

  const needle = `${CHILD_ENV_KEY}=${marker}`;
  let killed = 0;

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    try {
      const environ = readFileSync(`/proc/${pid}/environ`);
      if (!environ.includes(needle)) continue;
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // Process exited between the scan and the read, or it is not ours.
    }
  }

  return killed;
}

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function launchArgs(launch: ProviderLaunch, args: readonly string[]): string[] {
  return [...launch.args, ...args];
}

/**
 * Run a discovery command and return the last JSON object it printed.
 * The CLI writes `[cli-chat]` log lines and a final protocol line to stdout;
 * only the protocol line is JSON.
 */
export async function execJson(
  launch: ProviderLaunch,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<Record<string, unknown> | null> {
  const { stdout } = await execCommand(launch.command, launchArgs(launch, args), {
    env: launch.env,
    cwd: options.cwd,
    timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    signal: options.signal,
  });
  return lastJsonObject(stdout);
}

export function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not the protocol line; keep looking upwards.
    }
  }
  return null;
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Track every spawned CLI so a daemon shutdown does not leave Doubao processes
 * (and their images/temp files) behind. `exit` handlers must be synchronous,
 * which is why this uses kill() instead of the async terminateProcess().
 */
function trackChild(child: ChildProcess): ChildProcess {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const live of liveChildren) {
        try {
          live.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      liveChildren.clear();
    });
  }

  liveChildren.add(child);
  child.once("close", () => liveChildren.delete(child));
  return child;
}

export function spawnTurn(
  launch: ProviderLaunch,
  args: readonly string[],
  cwd?: string,
): ChildProcess {
  // stdin is ignored on purpose: `doubao -p` never reads it in headless mode, and a
  // writable pipe would keep the child waiting on a TTY that does not exist.
  return trackChild(
    spawnProcess(launch.command, launchArgs(launch, args), {
      cwd,
      env: childEnv(launch.env, launch.command),
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

/** Ask politely, then force. Doubao spawns helper processes, so a bare SIGINT can leave them behind. */
export async function stopProcess(child: ChildProcess, graceMs = 3000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  try {
    await terminateProcess(child, "SIGINT");
  } catch {
    // Already gone.
  }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
  ]);

  if (timedOut) {
    try {
      await terminateProcess(child, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
