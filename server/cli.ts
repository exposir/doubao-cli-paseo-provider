import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ChildProcess } from "node:child_process";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

/** Discovery commands must never be able to hang the provider catalogue. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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

export function spawnTurn(
  launch: ProviderLaunch,
  args: readonly string[],
  cwd?: string,
): ChildProcess {
  // stdin is ignored on purpose: `doubao -p` never reads it in headless mode, and a
  // writable pipe would keep the child waiting on a TTY that does not exist.
  return spawnProcess(launch.command, launchArgs(launch, args), {
    cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
