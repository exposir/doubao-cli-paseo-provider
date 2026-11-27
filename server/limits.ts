/**
 * Resource guards. Every limit here exists because a runaway agent must not take
 * the daemon's memory or the host's disk with it.
 */
export interface Limits {
  /** Concurrent Doubao processes per connection. Each one is ~150 MB. */
  maxConcurrentTurns: number;
  /** Hard cap for one turn. 0 disables the cap. */
  maxTurnMs: number;
  /** Kill a turn that stopped producing output for this long. 0 disables it. */
  stallTimeoutMs: number;
  /** Bytes of assistant text kept per turn; the rest is dropped with a marker. */
  maxAssistantBytes: number;
  /** Bytes of stderr kept for error reporting. */
  maxStderrBytes: number;
  /** Prompt size guard; the CLI receives the prompt as one argv entry. */
  maxPromptBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxConcurrentTurns: 2,
  maxTurnMs: 30 * 60_000,
  stallTimeoutMs: 5 * 60_000,
  maxAssistantBytes: 4 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxPromptBytes: 1024 * 1024,
};

export function resolveLimits(partial: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...partial };
}

/** Cut a string at a byte boundary without leaving a broken UTF-8 tail. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

/** A string buffer with a hard byte ceiling; further appends are discarded. */
export class BoundedText {
  private value = "";
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: string | Buffer): void {
    if (this.maxBytes <= 0 || this.truncated) return;

    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const remaining = this.maxBytes - this.bytes;
    if (buffer.length <= remaining) {
      this.value += buffer.toString();
      this.bytes += buffer.length;
      return;
    }

    this.value += buffer.subarray(0, remaining).toString("utf8").replace(/\uFFFD+$/, "");
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
