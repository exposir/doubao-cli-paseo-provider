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
import { BoundedText, resolveLimits, type Limits } from "./limits.js";
import { extractPromptText } from "./prompt.js";
import { readPersistedSessionId } from "./sessions.js";
import { NdjsonParser, applyStreamEvent, createTurnState, type TurnState } from "./stream.js";

/** Coalesce token deltas so the timeline does not get one event per token. */
const TEXT_FLUSH_INTERVAL_MS = 80;

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
  private activeProcess: ChildProcess | null = null;
  private interrupted = false;
  private closed = false;

  private turn: TurnState | null = null;
  private turnId: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastEmittedText = "";

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
    return this.activeProcess !== null;
  }

  public canStopRuntime(): boolean {
    return this.activeProcess === null;
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

    this.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: [
        { name: "help", description: "Show Doubao CLI help" },
        { name: "compact", description: "Compact the current conversation" },
      ],
    });

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
    if (this.activeProcess) {
      throw new DoubaoError("A turn is already running in this session", "TURN_ACTIVE");
    }

    const text = extractPromptText(prompt);
    if (!text) throw new DoubaoError("Prompt is empty", "EMPTY_PROMPT");

    const promptBytes = Buffer.byteLength(text);
    if (this.limits.maxPromptBytes > 0 && promptBytes > this.limits.maxPromptBytes) {
      throw new DoubaoError(
        `Prompt is ${promptBytes} bytes; the limit is ${this.limits.maxPromptBytes}`,
        "PROMPT_TOO_LARGE",
      );
    }

    const turnId = randomUUID();
    this.turnId = turnId;
    this.interrupted = false;
    this.lastEmittedText = "";

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

    const child = spawnTurn(this.launch, this.buildArgs(text), this.config.cwd);
    this.activeProcess = child;

    const parser = new NdjsonParser();
    const stderr = new BoundedText(this.limits.maxStderrBytes);

    let stopReason: "timeout" | "stall" | null = null;
    let turnTimer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;

    const armStallTimer = () => {
      if (this.limits.stallTimeoutMs <= 0) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stopReason = "stall";
        void stopProcess(child);
      }, this.limits.stallTimeoutMs);
    };

    if (this.limits.maxTurnMs > 0) {
      turnTimer = setTimeout(() => {
        stopReason = "timeout";
        void stopProcess(child);
      }, this.limits.maxTurnMs);
    }
    armStallTimer();

    child.stdout?.on("data", (chunk: Buffer) => {
      armStallTimer();
      for (const event of parser.push(chunk)) {
        const previousSessionId = state.sessionId;
        applyStreamEvent(state, event, { maxTextBytes: this.limits.maxAssistantBytes });

        if (state.sessionId && state.sessionId !== previousSessionId) {
          this.rememberSessionId(state.sessionId);
        }

        if (state.text !== this.lastEmittedText) this.scheduleFlush();
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      armStallTimer();
      stderr.append(chunk);
    });

    const exit = await waitForExit(child);

    if (turnTimer) clearTimeout(turnTimer);
    if (stallTimer) clearTimeout(stallTimer);

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushText(true);
    this.activeProcess = null;
    this.turn = null;

    if (this.interrupted) {
      this.emit({ type: "session.turn", sessionId: this.id, turnId, state: "canceled" });
      return;
    }

    if (stopReason === "timeout") {
      this.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId,
        state: "failed",
        error: {
          message: `Turn exceeded the ${this.limits.maxTurnMs} ms limit and was stopped`,
          code: "TURN_TIMEOUT",
        },
      });
      return;
    }

    if (stopReason === "stall") {
      this.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId,
        state: "failed",
        error: {
          message: `No output for ${this.limits.stallTimeoutMs} ms; the turn was stopped`,
          code: "TURN_STALLED",
        },
      });
      return;
    }

    if (state.error) {
      this.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId,
        state: "failed",
        error: { message: state.error, code: "DOUBAO_RESULT_ERROR" },
      });
      return;
    }

    if (exit.error) {
      this.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId,
        state: "failed",
        error: { message: exit.error, code: "SPAWN_ERROR" },
      });
      return;
    }

    if (exit.code !== 0) {
      const detail = summarizeStderr(stderr.toString()) || `Doubao CLI exited with code ${exit.code}`;
      this.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId,
        state: "failed",
        error: { message: detail, code: `EXIT_${exit.code}` },
      });
      return;
    }

    if (!state.text.trim()) {
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
  }

  public async interrupt(): Promise<void> {
    if (!this.activeProcess) return;
    this.interrupted = true;
    await stopProcess(this.activeProcess);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    // Let an in-flight turn report its cancellation before the session is marked closed,
    // otherwise the terminal turn event would be dropped.
    if (this.activeProcess) await this.interrupt();
    this.closed = true;
  }

  private buildArgs(text: string): string[] {
    return buildTurnArgs({
      sessionId: this.doubaoSessionId,
      text,
      cwd: this.config.cwd,
      model: this.config.model,
      thinkingOption: this.config.thinkingOption,
      mode: this.config.mode,
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

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushText(false);
    }, TEXT_FLUSH_INTERVAL_MS);
  }

  private flushText(force: boolean): void {
    const state = this.turn;
    const turnId = this.turnId;
    if (!state || !turnId) return;
    if (!state.text || state.text === this.lastEmittedText) return;
    if (!force && state.text.length - this.lastEmittedText.length < 1) return;

    this.lastEmittedText = state.text;
    this.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: { type: "assistant_message", id: `assistant:${turnId}`, text: state.text },
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
