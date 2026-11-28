import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type {
  ProviderCatalog,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderLaunch,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { buildTurnArgs } from "./args.js";
import { spawnTurn, stopProcess } from "./cli.js";
import { DoubaoError, summarizeStderr } from "./errors.js";
import { BoundedText, requireFreeDisk, resolveLimits, type Limits } from "./limits.js";
import { extractPromptText, validatePromptText } from "./prompt.js";
import {
  buildToolItem,
  extractToolEvents,
  toolCallKey,
  type ToolCall,
  type ToolResult,
} from "./tools.js";
import { readPersistedSessionId } from "./sessions.js";
import {
  NdjsonParser,
  applyStreamEvent,
  createTurnState,
  extractTextMessageId,
  resetMessageBuffer,
  type TurnState,
} from "./stream.js";

/** Coalesce token deltas so the timeline does not get one event per token. */
const TEXT_FLUSH_INTERVAL_MS = 80;
/** Emit once this many bytes accumulated, even if the interval is short. */
const TEXT_FLUSH_MIN_BYTES = 256;
/** But never let a slow trickle wait longer than this. */
const TEXT_FLUSH_MAX_IDLE_MS = 500;

/** Exit code `doubao` CLI returns when login is required or expired. */
const CLI_EXIT_LOGIN_REQUIRED = 4;
const MAX_STREAM_LINE_BYTES = 16 * 1024 * 1024;

function warn(message: string): void {
  console.warn(`[doubao-provider] ${message}`);
}

const RECURSIVE_COMMANDS = [
  /(?:^|[;&|]\s*)(?:\S*\/)?doubao(?:\s+(?:-\S+\s+\S+|-\S+))*\s+(?:-p|--resume)\b/,
  /(?:^|[;&|]\s*)(?:\S*\/)?paseo\s+(?:run|send|stop|daemon|plugin)\b/,
];

/** Detect a tool command that would start a Doubao/Paseo turn inside this one. */
function recursiveCommand(call: ToolCall): string | null {
  if (!/bash|shell|exec/i.test(call.name)) return null;
  const command = typeof call.input.command === "string" ? call.input.command : "";
  for (const pattern of RECURSIVE_COMMANDS) {
    const match = command.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

export interface SessionOptions {
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  catalog: () => ProviderCatalog;
  persistence?: ProviderPersistence;
  emit: (event: ProviderEvent) => void;
  limits?: Partial<Limits>;
}

export class Session {
  public readonly id: string;

  private config: ProviderSessionConfig;
  private readonly launch: ProviderLaunch;
  private readonly getCatalog: () => ProviderCatalog;
  private readonly emitEvent: (event: ProviderEvent) => void;
  private readonly limits: Limits;

  private doubaoSessionId: string | null;
  private turnInFlight = false;
  private activeProcess: ChildProcess | null = null;
  private interrupted = false;
  private closed = false;

  private turn: TurnState | null = null;
  private turnId: string | null = null;
  private assistantMessageSeq = 0;
  private emittedAnyAssistantText = false;
  private readonly toolCalls = new Map<string, ToolCall>();
  private readonly canceledTools = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private lastEmittedVersion = 0;
  private lastEmittedBytes = 0;
  private lastEmitAt = 0;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.config = options.config;
    this.launch = options.launch;
    this.getCatalog = options.catalog;
    this.emitEvent = options.emit;
    this.limits = resolveLimits(options.limits);
    this.doubaoSessionId = readPersistedSessionId(options.persistence);
  }

  public getPersistence(): ProviderPersistence | undefined {
    if (!this.doubaoSessionId) return undefined;
    return { version: 1, data: { doubaoSessionId: this.doubaoSessionId } };
  }

  public isBusy(): boolean {
    return this.turnInFlight || this.activeProcess !== null;
  }

  public canStopRuntime(): boolean {
    return !this.turnInFlight && this.activeProcess === null;
  }

  public open(requestId: string, capabilities: readonly string[]): void {
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities: [...capabilities],
      restoration: "core",
      persistence: this.getPersistence(),
      cwd: this.config.cwd,
      title: this.config.title ?? "Doubao session",
    });

    this.publishConfig();

    // `doubao -p` (non-interactive mode) does not interpret TUI/ACP slash commands.
    this.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: [],
    });

    if (process.env.DOUBAO_PASEO_SUPPRESS_NOTICES !== "1") {
      this.emit({
        type: "session.notice",
        sessionId: this.id,
        notice: {
          id: "headless-approvals",
          severity: "warning",
          title: "Doubao runs without an approval gate",
          description:
            "In headless `-p` mode Paseo cannot approve or deny tool calls: workspace actions run without confirmation, while actions requiring interactive approval are automatically denied by the CLI. Run the daemon or workspace in a container or under a dedicated user if you need isolation.",
        },
      });
    }

    this.emit({ type: "session.ready", requestId, sessionId: this.id });
  }

  public publishConfig(): void {
    const catalog = this.getCatalog();
    const model = this.config.model ?? catalog.defaultModel;
    const modelCatalog = catalog.models.find((entry) => entry.id === model);

    this.emit({
      type: "session.config",
      sessionId: this.id,
      config: {
        model,
        mode: this.config.mode ?? catalog.defaultMode,
        thinkingOption:
          this.config.thinkingOption ??
          modelCatalog?.defaultThinkingOptionId ??
          catalog.defaultThinkingOption,
        models: catalog.models,
        modes: catalog.modes,
        thinkingOptions: modelCatalog?.thinkingOptions ?? catalog.thinkingOptions ?? [],
        // Required by Paseo 0.15; deprecated but accepted in 0.17.
        settings: [],
      },
    });
  }

  public configure(changes: ProviderConfigChanges): void {
    if (changes.model !== undefined) this.config.model = changes.model ?? undefined;
    if (changes.mode !== undefined) this.config.mode = changes.mode ?? undefined;
    if (changes.thinkingOption !== undefined) {
      this.config.thinkingOption = changes.thinkingOption ?? undefined;
    }
    this.publishConfig();
  }

  public async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed) throw new DoubaoError("Session is closed");
    if (this.turnInFlight || this.activeProcess) {
      throw new DoubaoError("A turn is already running in this session", "TURN_ACTIVE");
    }

    const text = extractPromptText(prompt);
    validatePromptText(text, this.limits.maxPromptBytes);

    // Lock synchronously before awaiting disk checks so back-to-back prompts cannot race.
    this.turnInFlight = true;
    this.interrupted = false;

    try {
      if (this.limits.minFreeDiskBytes > 0) {
        await requireFreeDisk(this.config.cwd, this.limits.minFreeDiskBytes);
        if (this.closed) throw new DoubaoError("Session is closed");
      }

      const turnId = randomUUID();
      this.turnId = turnId;
      this.assistantMessageSeq = 0;
      this.emittedAnyAssistantText = false;
      this.lastEmittedVersion = 0;
      this.lastEmittedBytes = 0;
      this.lastEmitAt = 0;
      this.toolCalls.clear();
      this.canceledTools.clear();

      const state = createTurnState();
      this.turn = state;

      this.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: {
          type: "user_message",
          id: `user:${turnId}`,
          text,
          clientMessageId: prompt.clientMessageId,
        },
      });

      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId },
      });

      this.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });

      if (this.interrupted) {
        this.emit({ type: "session.turn", sessionId: this.id, turnId, state: "canceled" });
        return;
      }

      let child: ChildProcess;
      try {
        child = spawnTurn(this.launch, this.buildArgs(), this.config.cwd, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "session.turn",
          sessionId: this.id,
          turnId,
          state: "failed",
          error: { message, code: "SPAWN_ERROR" },
        });
        return;
      }
      this.activeProcess = child;

      const parser = new NdjsonParser(MAX_STREAM_LINE_BYTES);
      const stderr = new BoundedText(this.limits.maxStderrBytes);

      const stopSignal: {
        reason: "timeout" | "stall" | "line_too_large" | null;
      } = { reason: null };
      let turnTimer: NodeJS.Timeout | null = null;
      let stallTimer: NodeJS.Timeout | null = null;

      const armStallTimer = () => {
        if (this.limits.stallTimeoutMs <= 0) return;
        if (!stallTimer) {
          stallTimer = setTimeout(() => {
            stallTimer = null;
            stopSignal.reason = "stall";
            void stopProcess(child);
          }, this.limits.stallTimeoutMs);
        } else {
          // refresh() resets the deadline without allocating a new timer on every chunk.
          stallTimer.refresh();
        }
      };

      if (this.limits.maxTurnMs > 0) {
        turnTimer = setTimeout(() => {
          stopSignal.reason = "timeout";
          void stopProcess(child);
        }, this.limits.maxTurnMs);
      }
      armStallTimer();

      const parseChunk = (chunk: Buffer) => {
        if (stopSignal.reason === "line_too_large") return;
        armStallTimer();
        try {
          for (const event of parser.push(chunk)) {
            this.handleProtocolEvent(event, state, turnId);
          }
        } catch (error) {
          stopSignal.reason = "line_too_large";
          warn(
            `turn ${turnId} received a stream-json line above ${MAX_STREAM_LINE_BYTES} bytes: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          void stopProcess(child);
        }
      };
      child.stdout?.on("data", parseChunk);

      child.stderr?.on("data", (chunk: Buffer) => {
        armStallTimer();
        stderr.append(chunk);
      });

      const exit = await waitForExit(child);

      if (turnTimer) clearTimeout(turnTimer);
      if (stallTimer) clearTimeout(stallTimer);

      // Flush any trailing NDJSON event that arrived without a final newline.
      if (stopSignal.reason !== "line_too_large") {
        try {
          for (const event of parser.end()) {
            this.handleProtocolEvent(event, state, turnId);
          }
        } catch (error) {
          stopSignal.reason = "line_too_large";
          warn(
            `turn ${turnId} received a stream-json line above ${MAX_STREAM_LINE_BYTES} bytes: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await stopProcess(child);
        }
      }

      this.clearFlushTimer();
      this.flushText(true);
      this.activeProcess = null;
      this.turn = null;
      const failTurn = (message: string, code: string) => {
        const trace = state.logId ? ` (log_id: ${state.logId})` : "";
        if (trace) warn(`turn ${turnId} failed with ${code}${trace} (session ${this.id})`);
        this.emit({
          type: "session.turn",
          sessionId: this.id,
          turnId,
          state: "failed",
          error: { message: message + trace, code },
        });
      };

      if (state.permissionDenials.length > 0) {
        const summary = state.permissionDenials
          .map((denial) => denial.toolName ?? denial.prompt ?? "tool call")
          .join(", ");
        this.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: {
            id: `notice:denials:${turnId}`,
            type: "notification",
            level: "warning",
            message: `Doubao CLI automatically denied tool approval in headless mode: ${summary}`,
          },
        });
      }

      if (this.interrupted) {
        this.emit({ type: "session.turn", sessionId: this.id, turnId, state: "canceled" });
        return;
      }

      if (state.truncated) {
        warn(`assistant output truncated at ${this.limits.maxAssistantBytes} bytes (session ${this.id})`);
      }

      if (stopSignal.reason === "timeout") {
        warn(`turn ${turnId} exceeded ${this.limits.maxTurnMs} ms and was stopped (session ${this.id})`);
        this.forgetSessionId();
        failTurn(`Turn exceeded the ${this.limits.maxTurnMs} ms limit and was stopped`, "TURN_TIMEOUT");
        return;
      }

      if (stopSignal.reason === "stall") {
        warn(`turn ${turnId} produced no output for ${this.limits.stallTimeoutMs} ms (session ${this.id})`);
        this.forgetSessionId();
        failTurn(`No output for ${this.limits.stallTimeoutMs} ms; the turn was stopped`, "TURN_STALLED");
        return;
      }

      if (stopSignal.reason === "line_too_large") {
        this.forgetSessionId();
        failTurn(
          `Doubao stream-json emitted a line above ${MAX_STREAM_LINE_BYTES} bytes; the turn was stopped`,
          "STREAM_LINE_TOO_LARGE",
        );
        return;
      }

      if (state.error) {
        const code = state.errorCode
          ? `DOUBAO_${state.errorCode.toUpperCase()}`
          : "DOUBAO_RESULT_ERROR";
        failTurn(state.error, code);
        return;
      }

      if (exit.error) {
        failTurn(exit.error, "SPAWN_ERROR");
        return;
      }

      if (exit.code === null) {
        const detail = summarizeStderr(stderr.toString());
        const signal = exit.signal ?? "unknown signal";
        const hint =
          signal === "SIGKILL"
            ? " (possibly OOM, an external kill, or a request past the CLI service limit; split long analysis prompts)"
            : "";
        warn(`turn ${turnId} was killed by ${signal} (session ${this.id})`);
        this.forgetSessionId();
        failTurn(`Doubao CLI was killed by ${signal}${hint}${detail ? `: ${detail}` : ""}`, `SIGNAL_${signal}`);
        return;
      }

      if (exit.code !== 0) {
        const detail = summarizeStderr(stderr.toString()) || `Doubao CLI exited with code ${exit.code}`;
        // Preserve the persisted session id when auth merely needs a re-login.
        if (exit.code !== CLI_EXIT_LOGIN_REQUIRED && !/login_required/i.test(detail)) {
          this.forgetSessionId();
        }
        failTurn(detail, `EXIT_${exit.code}`);
        return;
      }

      if (!this.emittedAnyAssistantText && !state.text.trim()) {
        this.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: {
            type: "assistant_message",
            id: `assistant:${turnId}`,
            text: "Task completed with no textual output.",
          },
        });
      }

      this.emit({ type: "session.turn", sessionId: this.id, turnId, state: "completed" });
    } finally {
      this.clearFlushTimer();
      this.activeProcess = null;
      this.turn = null;
      this.turnInFlight = false;
    }
  }

  public async interrupt(): Promise<void> {
    if (!this.turnInFlight && !this.activeProcess) return;
    this.interrupted = true;
    if (this.activeProcess) await stopProcess(this.activeProcess);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    // Let an in-flight turn report its cancellation before the session is marked closed,
    // otherwise the terminal turn event would be dropped.
    if (this.turnInFlight || this.activeProcess) await this.interrupt();
    this.closed = true;
  }

  private handleProtocolEvent(event: unknown, state: TurnState, turnId: string): void {
    const incomingMessageId = extractTextMessageId(event);
    if (incomingMessageId && state.messageId && incomingMessageId !== state.messageId) {
      // A new assistant message started (e.g. after a tool call): finalize the previous
      // timeline item so multi-step replies do not overwrite or concatenate onto each other.
      this.clearFlushTimer();
      this.flushText(true);
      resetMessageBuffer(state, incomingMessageId);
      this.assistantMessageSeq += 1;
      this.lastEmittedBytes = 0;
      this.lastEmitAt = 0;
    }

    const previousSessionId = state.sessionId;
    const effect = applyStreamEvent(state, event, {
      maxTextBytes: this.limits.maxAssistantBytes,
    });

    if (state.sessionId && state.sessionId !== previousSessionId) {
      this.rememberSessionId(state.sessionId);
    }

    for (const toolEvent of extractToolEvents(event)) {
      const key = toolCallKey(toolEvent);
      if (toolEvent.kind === "call") {
        this.toolCalls.set(key, toolEvent);
        this.emitTool(toolEvent);

        const blocked = recursiveCommand(toolEvent);
        if (blocked && !this.canceledTools.has(key)) {
          this.canceledTools.add(key);
          warn(`blocked recursive command in ${this.id}: ${blocked}`);
          this.emit({
            type: "timeline.item",
            sessionId: this.id,
            item: {
              id: `notice:recursive:${turnId}`,
              type: "notification",
              level: "warning",
              message: `Blocked a recursive command: ${blocked}. A Doubao turn cannot run doubao or paseo inside itself.`,
            },
          });
          this.cancelTool(toolEvent);
          void this.interrupt();
        }
      } else {
        // Never let a late tool_result overwrite a tool call we explicitly canceled.
        if (this.canceledTools.has(key)) continue;
        const call = this.toolCalls.get(key);
        if (call) this.emitTool(call, toolEvent);
      }
    }

    if (effect === "text") this.scheduleFlush();
  }

  private buildArgs(): string[] {
    return buildTurnArgs({
      sessionId: this.doubaoSessionId,
      cwd: this.config.cwd,
      model: this.config.model,
      thinkingOption: this.config.thinkingOption,
      mode: this.config.mode,
    });
  }

  private emitTool(call: ToolCall, result?: ToolResult): void {
    this.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: buildToolItem(call, result),
    });
  }

  private cancelTool(call: ToolCall): void {
    const item = buildToolItem(call);
    this.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: { ...item, status: "canceled", error: null },
    });
  }

  private rememberSessionId(sessionId: string): void {
    if (this.doubaoSessionId === sessionId) return;
    this.doubaoSessionId = sessionId;
    const persistence = this.getPersistence();
    if (persistence) {
      this.emit({ type: "session.persistence", sessionId: this.id, persistence });
    }
  }

  /**
   * A turn killed mid-flight can leave the native session locked, and every
   * later --resume on it fails the same way. Drop the id so the next turn
   * starts a clean Doubao session instead of inheriting the dead one.
   */
  private forgetSessionId(): void {
    if (!this.doubaoSessionId) return;
    this.doubaoSessionId = null;
    this.emit({
      type: "session.persistence",
      sessionId: this.id,
      persistence: { version: 1, data: { doubaoSessionId: null } },
    });
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushText(false);
      // Keep a slow trickle moving: flushText emits once the idle window passes.
      if (this.turn && this.turn.version !== this.lastEmittedVersion) this.scheduleFlush();
    }, TEXT_FLUSH_INTERVAL_MS);
  }

  private assistantItemId(turnId: string): string {
    return this.assistantMessageSeq === 0
      ? `assistant:${turnId}`
      : `assistant:${turnId}:${this.assistantMessageSeq}`;
  }

  private flushText(force: boolean): void {
    const state = this.turn;
    const turnId = this.turnId;
    if (!state || !turnId) return;
    if (state.version === this.lastEmittedVersion) return;
    if (!state.text) return;

    const grown = Math.abs(state.byteLength - this.lastEmittedBytes);
    if (!force && grown < TEXT_FLUSH_MIN_BYTES) {
      const idle = Date.now() - this.lastEmitAt;
      if (idle < TEXT_FLUSH_MAX_IDLE_MS) return;
    }

    this.lastEmittedVersion = state.version;
    this.lastEmittedBytes = state.byteLength;
    this.lastEmitAt = Date.now();
    this.emittedAnyAssistantText = true;
    this.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: { type: "assistant_message", id: this.assistantItemId(turnId), text: state.text },
    });
  }

  private emit(event: ProviderEvent): void {
    // The connection drops events once it is closed; the session itself keeps
    // reporting terminal turn states so a closing turn is not left "started".
    this.emitEvent(event);
  }
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

function waitForExit(child: ChildProcess): Promise<ExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: ExitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once("close", (code, signal) => done({ code, signal }));
    child.once("error", (error) => done({ code: null, signal: null, error: error.message }));
  });
}
