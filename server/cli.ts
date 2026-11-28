import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type {
  ProviderLaunch,
  ProviderRegistration,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";

/** Discovery commands must never be able to hang the provider catalogue. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5000;
const VERSION_TIMEOUT_MS = 5000;

export const DOUBAO_DOCS_URL = "https://github.com/exposir/doubao-cli-paseo-provider";
const DOUBAO_INSTALL_URL = `${DOUBAO_DOCS_URL}#install`;

export interface DoubaoInstallationContext {
  launch?: ProviderLaunch & { resolved?: boolean };
  signal: AbortSignal;
}

export type DoubaoProviderRegistration = ProviderRegistration & {
  launchWrap?: true;
  docsUrl?: string;
  installation?: {
    installUrl?: string;
    inspect?(context: DoubaoInstallationContext): Promise<
      { status: "installed"; version?: string } | { status: "not_installed" }
    >;
  };
};

/**
 * Every child inherits this marker. A daemon that is SIGKILLed cannot run exit
 * hooks, so the next start scans for the marker and cleans up instead.
 */
export const CHILD_ENV_KEY = "PASEO_DOUBAO_CHILD";
const CHILD_OWNER_KEY = "PASEO_DOUBAO_OWNER";
const CHILD_MARKER = `paseo-${createHash("sha256")
  .update(process.env.PASEO_HOME ?? "default")
  .digest("hex")
  .slice(0, 12)}`;

export function probeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  // Prevent the doubao npm launcher from running network update checks.
  merged.DOUBAO_CLI_NO_UPDATE_CHECK = "1";
  return merged;
}

export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const merged = probeEnv(env);
  merged[CHILD_ENV_KEY] = CHILD_MARKER;
  merged[CHILD_OWNER_KEY] = String(process.pid);
  return merged;
}

export function baseCliArgs(args: readonly string[]): string[] {
  const base: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--acp") continue;
    if (args[index] === "acp" && args[index + 1] === "serve") {
      index += 1;
      continue;
    }
    base.push(args[index]);
  }
  return base;
}

export function hasAcpFlag(args: readonly string[]): boolean {
  return args.includes("--acp")
    || args.some((arg, index) => arg === "acp" && args[index + 1] === "serve");
}

export async function readDoubaoVersion(
  launch: ProviderLaunch | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!launch) return undefined;
  const { stdout } = await execCommand(
    launch.command,
    [...baseCliArgs(launch.args), "--version"],
    {
      env: probeEnv(launch.env),
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: 8192,
      signal,
    },
  );
  return /\b(\d+\.\d+\.\d+\S*)\b/.exec(stdout)?.[1];
}

export async function inspectDoubaoInstallation(
  context: DoubaoInstallationContext,
): Promise<{ status: "installed"; version?: string } | { status: "not_installed" }> {
  if (!context.launch || context.launch.resolved === false) return { status: "not_installed" };
  try {
    const version = await readDoubaoVersion(context.launch, context.signal);
    return { status: "installed", ...(version ? { version } : {}) };
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { status: "installed" };
  }
}

export function doubaoProviderInstallation(): NonNullable<DoubaoProviderRegistration["installation"]> {
  return { installUrl: DOUBAO_INSTALL_URL, inspect: inspectDoubaoInstallation };
}

export async function checkDoubaoAuth(launch: ProviderLaunch | undefined): Promise<ProviderStatus> {
  if (!launch) {
    return {
      available: false,
      diagnostic: "doubao was not found on PATH. Install the Doubao CLI and make sure it is reachable.",
    };
  }
  try {
    await execCommand(launch.command, [...baseCliArgs(launch.args), "auth", "status"], {
      env: probeEnv(launch.env),
      timeout: AUTH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { available: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      diagnostic: `doubao is installed but not usable (${message}). Run \`doubao login\` in a terminal.`,
    };
  }
}

let reaped = false;

export function reapStaleChildrenOnce(): void {
  // Only a daemon that owns a Paseo home should sweep.
  if (reaped || !process.env.PASEO_HOME) return;
  reaped = true;
  const killed = reapStaleChildren();
  if (killed > 0) {
    console.warn(`[doubao-provider] reaped ${killed} stale child process(es) from a previous daemon`);
  }
}

/**
 * Kill processes left behind by a previous daemon instance. Only processes that
 * carry this home's marker are touched, so a manual `doubao` session survives.
 */
export function reapStaleChildren(marker: string = CHILD_MARKER): number {
  const needle = `${CHILD_ENV_KEY}=${marker}`;
  let killed = 0;

  for (const { pid, owner } of findMarkedChildren(needle)) {
    if (pid === process.pid || ownerIsAlive(owner)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // Process exited between the scan and the kill, or it is not ours.
    }
  }

  return killed;
}

function ownerIsAlive(value: string | undefined): boolean {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type MarkedChild = { pid: number; owner?: string };

function findMarkedChildren(needle: string): MarkedChild[] {
  const fromProc = scanProcEnviron(needle);
  if (fromProc !== null) return fromProc;
  if (process.platform === "darwin") return scanDarwinPs(needle);
  return [];
}

function scanProcEnviron(needle: string): MarkedChild[] | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }

  const children: MarkedChild[] = [];
  const ownerKey = `${CHILD_OWNER_KEY}=`;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    try {
      const environ = readFileSync(`/proc/${pid}/environ`);
      if (!environ.includes(needle)) continue;
      const variables = environ.toString().split("\0");
      if (!variables.includes(needle)) continue;
      const owner = variables.find((entry) => entry.startsWith(ownerKey))?.slice(ownerKey.length);
      children.push({ pid, owner });
    } catch {
      // Process exited between the scan and the read, or it is not ours.
    }
  }
  return children;
}

function scanDarwinPs(needle: string): MarkedChild[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-axww", "-E", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match whitespace-delimited KEY=VALUE from the environment tail, not quoted literals.
  const pattern = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`);
  const ownerPattern = new RegExp(`(?:^|\\s)${CHILD_OWNER_KEY}=(\\d+)(?:\\s|$)`);
  const children: MarkedChild[] = [];

  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const rest = match[2];
    if (rest.startsWith("ps ")) continue;
    if (pattern.test(rest)) children.push({ pid, owner: ownerPattern.exec(rest)?.[1] });
  }
  return children;
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
    env: probeEnv(launch.env),
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
 * Signal the child's entire process group on POSIX (doubao's npm launcher spawns a
 * native binary plus helper subprocesses), falling back to the direct PID.
 */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall back to direct kill if the child is not a process group leader.
    }
  }
  return false;
}

function killChildTreeSync(child: ChildProcess, signal: NodeJS.Signals): void {
  if (signalProcessGroup(child, signal)) return;
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

export async function killChildTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (process.platform !== "win32") {
    killChildTreeSync(child, signal);
    return;
  }
  await terminateProcess(child, signal);
}

/**
 * Track every spawned CLI so a daemon shutdown does not leave Doubao processes
 * (and their helper subprocesses) behind. `exit` handlers must be synchronous,
 * which is why this uses killChildTreeSync().
 */
function trackChild(child: ChildProcess): ChildProcess {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const live of liveChildren) {
        killChildTreeSync(live, "SIGKILL");
      }
      liveChildren.clear();
    });
  }

  liveChildren.add(child);
  child.once("close", () => liveChildren.delete(child));
  return child;
}

function spawnTracked(
  launch: ProviderLaunch,
  args: readonly string[],
  cwd?: string,
  wrap?: readonly [string, ...string[]],
): ChildProcess {
  // Expand the wrapper here since the 0.15 process API has no wrap option.
  const command = wrap?.[0] ?? launch.command;
  const cliArgs = launchArgs(launch, args);
  const invocation = wrap ? [...wrap.slice(1), launch.command, ...cliArgs] : cliArgs;
  const child = trackChild(spawnProcess(command, invocation, {
    cwd,
    env: childEnv(launch.env),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  }));
  child.stdin?.on("error", () => {});
  return child;
}

export function spawnAcpProcess(
  launch: ProviderLaunch,
  cwd?: string,
  wrap?: readonly [string, ...string[]],
): ChildProcess {
  return spawnTracked(launch, [], cwd, wrap);
}

export function spawnTurn(
  launch: ProviderLaunch,
  args: readonly string[],
  cwd?: string,
  stdinText?: string,
): ChildProcess {
  const child = spawnTracked(launch, args, cwd);

  // Ignore EPIPE when the CLI exits before reading stdin (e.g. invalid args or auth error).
  if (stdinText !== undefined) {
    child.stdin?.end(stdinText, "utf8");
  } else {
    child.stdin?.end();
  }

  return child;
}

/** Ask politely, then force. Doubao spawns helper processes, so signal the whole process group. */
export async function stopProcess(child: ChildProcess, graceMs = 3000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  try {
    await killChildTree(child, "SIGINT");
  } catch {
    // Already gone.
  }

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), graceMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (timedOut) {
    try {
      await killChildTree(child, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
