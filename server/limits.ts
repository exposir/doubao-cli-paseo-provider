/**
 * Resource guards. Every limit here exists because a runaway agent must not take
 * the daemon's memory or the host's disk with it.
 */
import { statfs } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { DoubaoError } from "./errors.js";

export interface Limits {
  /** Active turns across both transports and all connections. */
  maxConcurrentTurns: number;
  /** Hard cap for one turn. 0 disables the cap. */
  maxTurnMs: number;
  /** Kill a turn that stopped producing output for this long. 0 disables it. */
  stallTimeoutMs: number;
  /** Reclaim ACP runtimes after this long without work. 0 disables reclamation. */
  idleRuntimeMs: number;
  /** Bytes of assistant text kept per turn; the rest is dropped with a marker. */
  maxAssistantBytes: number;
  /** Bytes of stderr kept for error reporting. */
  maxStderrBytes: number;
  /** Prompt size guard; matches `doubao -p -` stdin limit (1 MiB UTF-8). */
  maxPromptBytes: number;
  /** Refuse to start a turn when the workspace filesystem has less free space. */
  minFreeDiskBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxConcurrentTurns: 2,
  maxTurnMs: 30 * 60_000,
  stallTimeoutMs: 5 * 60_000,
  idleRuntimeMs: 5 * 60_000,
  maxAssistantBytes: 4 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxPromptBytes: 1024 * 1024,
  minFreeDiskBytes: 512 * 1024 * 1024,
};

const ENV_KEYS: ReadonlyArray<readonly [keyof Limits, string]> = [
  ["maxConcurrentTurns", "DOUBAO_PASEO_MAX_TURNS"],
  ["maxTurnMs", "DOUBAO_PASEO_MAX_TURN_MS"],
  ["stallTimeoutMs", "DOUBAO_PASEO_STALL_MS"],
  ["idleRuntimeMs", "DOUBAO_PASEO_IDLE_MS"],
  ["maxAssistantBytes", "DOUBAO_PASEO_MAX_TEXT_BYTES"],
  ["maxStderrBytes", "DOUBAO_PASEO_MAX_STDERR_BYTES"],
  ["maxPromptBytes", "DOUBAO_PASEO_MAX_PROMPT_BYTES"],
  ["minFreeDiskBytes", "DOUBAO_PASEO_MIN_FREE_DISK_MB"],
];

/** Read operator overrides so limits can be tuned without rebuilding the plugin. */
export function envLimits(env: NodeJS.ProcessEnv = process.env): Partial<Limits> {
  const partial: Partial<Limits> = {};

  for (const [key, name] of ENV_KEYS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;

    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;

    partial[key] = name === "DOUBAO_PASEO_MIN_FREE_DISK_MB" ? value * 1024 * 1024 : value;
  }

  return partial;
}

export function resolveLimits(partial: Partial<Limits> = {}): Limits {
  const merged = { ...DEFAULT_LIMITS, ...envLimits(), ...partial };
  return {
    maxConcurrentTurns: sanitize(merged.maxConcurrentTurns, DEFAULT_LIMITS.maxConcurrentTurns),
    maxTurnMs: sanitize(merged.maxTurnMs, DEFAULT_LIMITS.maxTurnMs),
    stallTimeoutMs: sanitize(merged.stallTimeoutMs, DEFAULT_LIMITS.stallTimeoutMs),
    idleRuntimeMs: sanitize(merged.idleRuntimeMs, DEFAULT_LIMITS.idleRuntimeMs),
    maxAssistantBytes: sanitize(merged.maxAssistantBytes, DEFAULT_LIMITS.maxAssistantBytes),
    maxStderrBytes: sanitize(merged.maxStderrBytes, DEFAULT_LIMITS.maxStderrBytes),
    maxPromptBytes: sanitize(merged.maxPromptBytes, DEFAULT_LIMITS.maxPromptBytes),
    minFreeDiskBytes: sanitize(merged.minFreeDiskBytes, DEFAULT_LIMITS.minFreeDiskBytes),
  };
}

/** Negative, NaN or infinite limits silently disable a guard; fall back instead. */
function sanitize(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Free bytes on the filesystem that holds `path`; unknown filesystems do not block turns. */
export async function freeDiskBytes(path: string): Promise<number> {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function requireFreeDisk(cwd: string, minFreeBytes: number): Promise<void> {
  if (minFreeBytes <= 0) return;
  const freeBytes = await freeDiskBytes(cwd);
  if (freeBytes >= minFreeBytes) return;
  const freeMb = Math.floor(freeBytes / 1024 / 1024);
  const requiredMb = Math.ceil(minFreeBytes / 1024 / 1024);
  console.warn(`[doubao-provider] refusing turn in ${cwd}: ${freeMb} MB free, ${requiredMb} MB required`);
  throw new DoubaoError(
    `Only ${freeMb} MB free in ${cwd}; at least ${requiredMb} MB is required`,
    "DISK_LOW",
  );
}

let activeTurns = 0;

export async function withTurnSlot(limit: number, run: () => Promise<void>): Promise<void> {
  if (limit > 0 && activeTurns >= limit) {
    console.warn(`[doubao-provider] refusing turn: ${activeTurns} running, limit ${limit}`);
    throw new DoubaoError(
      `Too many concurrent Doubao turns (limit ${limit}); wait for one to finish or raise the limit`,
      "TOO_MANY_TURNS",
    );
  }
  activeTurns += 1;
  try {
    await run();
  } finally {
    activeTurns -= 1;
  }
}

/** Cut a string at a byte boundary without leaving a broken UTF-8 tail. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

/** A string buffer with a hard byte ceiling; further appends are discarded. */
export class BoundedText {
  private readonly decoder = new StringDecoder("utf8");
  private value = "";
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: string | Buffer): void {
    if (this.maxBytes <= 0 || this.truncated) return;

    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const remaining = this.maxBytes - this.bytes;
    if (buffer.length <= remaining) {
      this.value += this.decoder.write(buffer);
      this.bytes += buffer.length;
      return;
    }

    this.value += this.decoder.write(buffer.subarray(0, remaining));
    this.decoder.end();
    this.bytes = this.maxBytes;
    this.truncated = true;
    this.value += "\n[truncated]";
  }

  toString(): string {
    return this.value;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }
}
