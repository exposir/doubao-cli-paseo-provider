import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ProviderCatalog,
  ProviderContent,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderLaunch,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import {
  acpOptionValues,
  selectedAcpConfigOption,
  asRecord,
  buildAcpElicitationRequest,
  buildAcpElicitationResponse,
  buildAcpPermissionRequest,
  field,
  formatAcpPrompt,
  mapAcpCommands,
  mapAcpConfig,
  records,
  toAcpMcpServers,
  type AcpElicitationSpec,
  type AcpPromptBlock,
  type AcpResponder,
} from "./acp-protocol.js";
import { AcpRuntime, settlesWithin } from "./acp-runtime.js";
import { AcpTimeline } from "./acp-timeline.js";
import { DoubaoError, errorPayload } from "./errors.js";
import { requireFreeDisk, type Limits } from "./limits.js";
import { validatePromptText } from "./prompt.js";

const CANCEL_GRACE_MS = 2500;
const CANCELLED = { outcome: { outcome: "cancelled" } };
const CANCELLED_ELICITATION = { action: "cancel" };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 64 * 1024;
const sessionImageDirs = new Set<string>();
let imageExitHookInstalled = false;

type SessionConfig = ProviderSessionConfig & { wrap?: readonly [string, ...string[]] };
type Selection = Pick<ProviderConfigChanges, "model" | "mode" | "thinkingOption">;
type RpcObject = Record<string, unknown>;
type History = "replay" | "skip";
type Commands = Extract<ProviderEvent, { type: "session.commands" }>["commands"];
type PendingPermission = {
  actions: NonNullable<ProviderPermissionRequest["actions"]>;
  reply: AcpResponder;
};
type PendingElicitation = {
  spec: AcpElicitationSpec;
  reply: AcpResponder;
};

interface ActiveTurn {
  id: string;
  startup: AbortController;
  timeline: AcpTimeline;
  completion: Promise<void>;
  deadline?: NodeJS.Timeout;
  stall?: NodeJS.Timeout;
  wire?: { runtime: AcpRuntime; sessionId: string; response: Promise<RpcObject> };
  stop?: { error?: DoubaoError; done: Promise<void> };
  runtimeFailure?: DoubaoError;
}

interface SessionOptions {
  id: string;
  config: SessionConfig;
  persistence?: ProviderPersistence;
  launch: ProviderLaunch;
  catalog(): ProviderCatalog;
  emit(event: ProviderEvent): void;
  limits: Limits;
  startupTimeoutMs: number;
  capabilities: readonly string[];
}

export function acpPersistence(sessionId: string | null): ProviderPersistence {
  return { version: 1, data: { sessionId } };
}

export class AcpSession {
  private readonly id: string;
  private readonly config: SessionConfig;
  private readonly limits: Limits;
  private readonly shutdown = new AbortController();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingElicitations = new Map<string, PendingElicitation>();
  private readonly systemPrompt?: string;
  private sessionId: string | null;
  private bound: boolean;
  private systemPromptPending: boolean;
  private selection: Selection;
  private defaults?: Selection;
  private modes?: RpcObject;
  private configOptions: RpcObject[] = [];
  private commands: Commands = [];
  private runtime?: AcpRuntime;
  private retiring?: Promise<void>;
  private operation?: Promise<void>;
  private turn?: ActiveTurn;
  private closing?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private loadPhase?: History;
  private replay?: AcpTimeline;
  private opened = false;
  private attaching = false;
  private warnedLostSession = false;
  private persistenceCleared = false;
  private imageDir?: string;
  private imageSequence = 0;

  constructor(private readonly options: SessionOptions) {
    this.id = options.id;
    this.config = options.config;
    this.limits = options.limits;
    this.sessionId = field(asRecord(options.persistence?.data), "sessionId") || null;
    this.bound = this.sessionId !== null;
    this.systemPrompt = this.config.systemPrompt?.trim() || undefined;
    this.systemPromptPending = !this.bound && Boolean(this.systemPrompt);
    this.selection = {
      model: this.config.model,
      mode: this.config.mode,
      thinkingOption: this.config.thinkingOption,
    };
  }

  open(requestId: string, history: History): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureRuntime(history, this.shutdown.signal);
      this.opened = true;
      this.options.emit({
        type: "session.opened",
        requestId,
        sessionId: this.id,
        capabilities: this.options.capabilities,
        restoration: "core",
        persistence: this.persistence(),
        cwd: this.config.cwd,
        title: this.config.title ?? "Doubao session",
      });
      if (this.persistenceCleared) this.publishPersistenceClear();
      this.publishConfig();
      this.publishCommands();
      this.publishLostSession();
      this.options.emit({ type: "session.ready", requestId, sessionId: this.id });
    });
  }

  configure(changes: ProviderConfigChanges): Promise<void> {
    return this.exclusive(async () => {
      const runtime = await this.ensureRuntime("skip", this.shutdown.signal);
      try {
        await this.applyConfig(runtime, changes, this.shutdown.signal, false);
      } catch (error) {
        await this.recoverIfLost(error);
        throw runtime.withDiagnostic(error);
      } finally {
        this.rememberConfig();
        this.publishConfig();
      }
    });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    this.requireIdle();
    let remainingResourceBytes = MAX_TEXT_FILE_BYTES;
    const rendered = formatAcpPrompt(prompt, {
      image: (item) => this.materializeImage(item),
      uploadedFile: (item) => {
        const resource = this.workspaceResourceLink(item);
        if (!resource || resource.bytes > remainingResourceBytes) return undefined;
        remainingResourceBytes -= resource.bytes;
        return resource.link;
      },
    });
    const blocks = rendered.blocks;
    const text = rendered.text;
    validatePromptText(text, this.limits.maxPromptBytes);
    this.clearIdleTimer();

    // Acquire the session before the first asynchronous operation, including disk checks.
    const id = randomUUID();
    const turn: ActiveTurn = {
      id,
      startup: new AbortController(),
      timeline: this.createTimeline(id),
      completion: Promise.resolve().then(() => this.runTurn(turn, prompt, blocks, text)),
    };
    this.turn = turn;
    try {
      await turn.completion;
    } catch (error) {
      if (turn.stop && errorPayload(error).code === "CLOSED") return;
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    this.stopTurn(turn);
    // A rejected prompt admission is reported by the prompt route.
    await turn.completion.catch(() => undefined);
  }

  respondToPermission(id: string, response: ProviderPermissionResponse): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) {
      const elicitation = this.pendingElicitations.get(id);
      if (!elicitation) return;
      const turn = this.turn;
      if (turn && response.behavior === "deny" && response.interrupt) {
        this.stopTurn(turn);
        return;
      }
      this.resolveElicitation(id, elicitation, response);
      if (turn) this.armStallTimer(turn);
      return;
    }
    const selected = response.selectedActionId === undefined
      ? pending.actions.find((action) => action.behavior === response.behavior)
      : pending.actions.find((action) => action.id === response.selectedActionId && action.behavior === response.behavior);
    const turn = this.turn;
    if (turn && response.behavior === "deny" && response.interrupt) {
      this.stopTurn(turn);
      return;
    }
    this.resolvePermission(id, pending, selected?.id);
    if (turn) this.armStallTimer(turn);
  }

  canStopRuntime(): boolean {
    return !this.turn && !this.operation && !this.hasPendingInteraction();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.clearIdleTimer();
      const stopped = this.interrupt();
      this.shutdown.abort(new DoubaoError("Session is closed", "CLOSED"));
      await stopped;
      await this.operation?.catch(() => undefined);
      this.cancelPermissions();
      this.cancelElicitations();
      await this.retireRuntime();
      this.cleanupImages();
    });
    return this.closing;
  }

  private async runTurn(
    turn: ActiveTurn,
    prompt: ProviderPrompt,
    blocks: AcpPromptBlock[],
    text: string,
  ): Promise<void> {
    let started = false;
    let runtime: AcpRuntime | undefined;
    let state: "completed" | "canceled" | "failed" = "completed";
    let failure: DoubaoError | undefined;
    try {
      await requireFreeDisk(this.config.cwd, this.limits.minFreeDiskBytes);
      if (this.closing) throw new DoubaoError("Session is closed", "CLOSED");
      if (turn.stop) {
        throw turn.stop.error
          ?? new DoubaoError("Turn canceled before start", "DOUBAO_REQUEST_CANCELLED");
      }
      started = true;
      this.emitItem({ type: "user_message", id: `user:${turn.id}`, text, clientMessageId: prompt.clientMessageId });
      this.options.emit({
        type: "session.prompt_result", sessionId: this.id, clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId: turn.id },
      });
      this.options.emit({ type: "session.turn", sessionId: this.id, turnId: turn.id, state: "started" });
      if (turn.stop) return;

      if (this.limits.maxTurnMs > 0) {
        turn.deadline = setTimeout(() => this.stopTurn(turn, new DoubaoError(
          `Turn exceeded the ${this.limits.maxTurnMs} ms limit and was stopped`, "TURN_TIMEOUT",
        )), this.limits.maxTurnMs);
      }
      runtime = await this.ensureRuntime("skip", turn.startup.signal);
      if (turn.stop) return;
      const wireBlocks = this.applySystemPrompt(prompt, blocks, text);
      const sessionId = this.sessionId!;
      const response = runtime.rpc.request("session/prompt", { sessionId, prompt: wireBlocks });
      turn.wire = { runtime, sessionId, response };
      this.armStallTimer(turn);
      const result = await response;
      if (result.stopReason === "end_turn" && !this.bound && this.sessionId === sessionId) {
        this.bound = true;
        this.systemPromptPending = false;
        this.publishPersistence();
      }
      if (result.stopReason === "cancelled") state = "canceled";
      else if (result.stopReason !== "end_turn") {
        throw new DoubaoError("Doubao ACP prompt returned an invalid stop reason", "ACP_PROTOCOL_ERROR");
      }
    } catch (error) {
      if (!started) throw error;
      await this.recoverIfLost(error);
      const payload = errorPayload(error);
      if (payload.code === "DOUBAO_REQUEST_CANCELLED") {
        state = "canceled";
      } else {
        state = "failed";
        failure = runtime?.withDiagnostic(error) ?? new DoubaoError(payload.message, payload.code);
      }
    } finally {
      clearTimeout(turn.deadline);
      clearTimeout(turn.stall);
      if (turn.stop) {
        await turn.stop.done;
        const error = turn.stop.error;
        failure = error && (runtime?.withDiagnostic(error) ?? error);
        state = failure ? "failed" : "canceled";
      }
      this.cancelPermissions();
      this.cancelElicitations();
      turn.timeline.finish(started ? state : undefined);
      this.turn = undefined;
      this.armIdleTimer();
      if (started) {
        this.options.emit({
          type: "session.turn", sessionId: this.id, turnId: turn.id, state,
          ...(failure ? { error: errorPayload(failure) } : {}),
        });
      }
      if (turn.runtimeFailure) this.publishRuntimeFailure(turn.runtimeFailure);
    }
  }

  private stopTurn(turn: ActiveTurn, error?: DoubaoError): void {
    if (turn.stop) return;
    turn.stop = { error, done: Promise.resolve().then(async () => {
      this.cancelPermissions();
      this.cancelElicitations();
      const wire = turn.wire;
      if (!wire) {
        turn.startup.abort(new DoubaoError("Turn canceled before prompt submission", "DOUBAO_REQUEST_CANCELLED"));
        return;
      }
      wire.runtime.rpc.notify("session/cancel", { sessionId: wire.sessionId });
      if (await settlesWithin(wire.response, CANCEL_GRACE_MS)) return;

      this.forgetSession();
      await this.retireRuntime(true);
    }) };
    clearTimeout(turn.deadline);
    clearTimeout(turn.stall);
  }

  private armStallTimer(turn: ActiveTurn): void {
    if (!turn.wire || turn.stop || this.limits.stallTimeoutMs <= 0 || this.hasPendingInteraction()) return;
    if (turn.stall) {
      turn.stall.refresh();
      return;
    }
    turn.stall = setTimeout(() => this.stopTurn(turn, new DoubaoError(
      `No output for ${this.limits.stallTimeoutMs} ms; the turn was stopped`, "TURN_STALLED",
    )), this.limits.stallTimeoutMs);
  }

  private handleRequest(method: string, params: RpcObject, reply: AcpResponder): void {
    if (method === "fs/read_text_file") {
      this.handleReadTextFile(params, reply);
      return;
    }
    if (method === "session/request_permission") {
      this.handlePermissionRequest(params, reply);
      return;
    }
    if (method === "elicitation/create") {
      this.handleElicitationRequest(params, reply);
      return;
    }
    reply.error(-32601, "Method not found");
  }

  private handlePermissionRequest(params: RpcObject, reply: AcpResponder): void {
    const turn = this.turn;
    if (!turn?.wire || turn.stop || params.sessionId !== this.sessionId || !this.options.capabilities.includes("permission")) {
      reply.result(CANCELLED);
      return;
    }
    turn.timeline.flush();
    const request = buildAcpPermissionRequest(randomUUID(), params);
    if (!request.actions?.length) {
      reply.result(CANCELLED);
      return;
    }
    this.pendingPermissions.set(request.id, { actions: request.actions, reply });
    clearTimeout(turn.stall);
    turn.stall = undefined;
    this.options.emit({ type: "session.permission", sessionId: this.id, request });
  }

  private handleElicitationRequest(params: RpcObject, reply: AcpResponder): void {
    const turn = this.turn;
    if (!turn?.wire || turn.stop || params.sessionId !== this.sessionId || !this.options.capabilities.includes("permission")) {
      reply.result(CANCELLED_ELICITATION);
      return;
    }
    const spec = buildAcpElicitationRequest(randomUUID(), params);
    if (spec.questions.length === 0) {
      reply.result(CANCELLED_ELICITATION);
      return;
    }
    turn.timeline.flush();
    this.pendingElicitations.set(spec.request.id, { spec, reply });
    clearTimeout(turn.stall);
    turn.stall = undefined;
    this.options.emit({ type: "session.permission", sessionId: this.id, request: spec.request });
  }

  private resolvePermission(id: string, permission: PendingPermission, optionId?: string): void {
    this.pendingPermissions.delete(id);
    permission.reply.result(optionId ? { outcome: { outcome: "selected", optionId } } : CANCELLED);
    this.options.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId: id });
  }

  private cancelPermissions(): void {
    for (const [id, permission] of this.pendingPermissions) this.resolvePermission(id, permission);
  }

  private resolveElicitation(
    id: string,
    pending: PendingElicitation,
    response: ProviderPermissionResponse,
  ): void {
    this.pendingElicitations.delete(id);
    pending.reply.result(buildAcpElicitationResponse(pending.spec, response));
    this.options.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId: id });
  }

  private cancelElicitations(): void {
    for (const [id, pending] of this.pendingElicitations) {
      this.resolveElicitation(id, pending, { behavior: "deny" });
    }
  }

  private handleReadTextFile(params: RpcObject, reply: AcpResponder): void {
    try {
      if (params.sessionId !== this.sessionId) throw new Error("Unknown ACP session");
      const path = field(params, "path");
      if (!path) throw new Error("Missing file path");
      const file = this.readWorkspaceFile(path);
      const line = positiveInteger(params.line, "line");
      const limit = positiveInteger(params.limit, "limit");
      const content = line === undefined && limit === undefined
        ? file.content
        : file.content.split("\n")
          .slice((line ?? 1) - 1, limit === undefined ? undefined : (line ?? 1) - 1 + limit)
          .join("\n");
      reply.result({ content });
    } catch (error) {
      reply.error(-32602, error instanceof Error ? error.message : String(error));
    }
  }

  private readWorkspaceFile(path: string): { realPath: string; content: string } {
    const root = realpathSync(resolve(this.config.cwd));
    const realPath = realpathSync(resolve(this.config.cwd, path));
    const relation = relative(root, realPath);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error("File is outside the session workspace");
    }
    const stat = statSync(realPath);
    if (!stat.isFile()) throw new Error("Path is not a regular file");
    accessSync(realPath, fsConstants.R_OK);
    if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error("Text file exceeds 64 KiB");
    const bytes = readFileSync(realPath);
    if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw new Error("Text file exceeds 64 KiB");
    if (bytes.includes(0)) throw new Error("Binary files are not supported");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("File is not valid UTF-8 text");
    }
    return { realPath, content };
  }

  private workspaceResourceLink(
    item: ProviderContent,
  ): { link: AcpPromptBlock; bytes: number } | undefined {
    if (item.type !== "uploaded_file") return undefined;
    try {
      const file = this.readWorkspaceFile(item.path);
      return {
        link: { type: "resource_link", uri: pathToFileURL(file.realPath).href, name: item.fileName },
        bytes: Buffer.byteLength(file.content),
      };
    } catch {
      return undefined;
    }
  }

  private materializeImage(item: Extract<ProviderContent, { type: "image" }>): string {
    const fallback = `[Attached image (${item.mimeType})]`;
    const bytes = decodeBase64Image(item.data);
    if (!bytes) return fallback;
    try {
      const dir = this.ensureImageDirectory();
      const extension = imageExtension(item.mimeType);
      const path = join(dir, `image-${++this.imageSequence}.${extension}`);
      writeFileSync(path, bytes, { mode: 0o600 });
      chmodSync(path, 0o600);
      return `[Attached image: ${path} (${item.mimeType}). Read this image file directly to inspect it.]`;
    } catch {
      return fallback;
    }
  }

  private ensureImageDirectory(): string {
    if (this.imageDir) return this.imageDir;
    const dir = mkdtempSync(join(tmpdir(), "paseo-doubao-img-"));
    chmodSync(dir, 0o700);
    sessionImageDirs.add(dir);
    if (!imageExitHookInstalled) {
      imageExitHookInstalled = true;
      process.once("exit", () => {
        for (const pending of sessionImageDirs) {
          try {
            rmSync(pending, { recursive: true, force: true });
          } catch {
            // Process exit cleanup is best effort.
          }
        }
        sessionImageDirs.clear();
      });
    }
    this.imageDir = dir;
    return dir;
  }

  private cleanupImages(): void {
    if (!this.imageDir) return;
    const dir = this.imageDir;
    this.imageDir = undefined;
    sessionImageDirs.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }

  private applySystemPrompt(
    prompt: ProviderPrompt,
    blocks: AcpPromptBlock[],
    text: string,
  ): AcpPromptBlock[] {
    if (!this.systemPromptPending || !this.systemPrompt || this.bound
      || prompt.input.type !== "message" || text.startsWith("/")) return blocks;
    const header = `[System instructions]\n${this.systemPrompt}\n\n[User message]\n`;
    validatePromptText(`${header}${text}`, this.limits.maxPromptBytes);
    if (blocks[0]?.type === "text") {
      return [
        { type: "text", text: `${header}${blocks[0].text}` },
        ...blocks.slice(1),
      ];
    }
    return [{ type: "text", text: header }, ...blocks];
  }

  private async ensureRuntime(history: History, signal: AbortSignal): Promise<AcpRuntime> {
    await this.retiring;
    signal.throwIfAborted();
    if (this.runtime) return this.runtime;

    this.attaching = true;
    this.modes = undefined;
    this.configOptions = [];
    this.commands = [];
    let runtime: AcpRuntime | undefined;
    let runtimeFailure: DoubaoError | undefined;
    try {
      runtime = new AcpRuntime({
        launch: { ...this.options.launch, env: { ...this.options.launch.env, ...this.config.env } },
        cwd: this.config.cwd,
        wrap: this.config.wrap,
        maxStderrBytes: this.limits.maxStderrBytes,
        onActivity: () => {
          if (this.turn) this.armStallTimer(this.turn);
        },
        handlers: {
          notification: (method, params) => {
            if (method === "session/update" && runtime === this.runtime) this.handleUpdate(params);
          },
          request: (method, params, reply) => this.handleRequest(method, params, reply),
        },
        onFailure: (error) => {
          if (runtime !== this.runtime) return;
          runtimeFailure = error;
          this.cancelPermissions();
          this.cancelElicitations();
          if (this.turn) this.turn.runtimeFailure = error;
          else this.publishRuntimeFailure(error);
          void this.retireRuntime(true);
        },
      });
      this.runtime = runtime;
      await runtime.initialize(this.options.startupTimeoutMs, signal);
      const params = { cwd: this.config.cwd, mcpServers: toAcpMcpServers(this.config.mcpServers) };
      const options = { signal, timeoutMs: this.options.startupTimeoutMs };
      if (this.bound && this.sessionId) {
        try {
          this.loadPhase = history;
          if (history === "replay") this.replay = this.createTimeline(`replay:${this.sessionId}`);
          await runtime.rpc.request("session/load", { sessionId: this.sessionId, ...params }, {
            ...options,
            onResult: (result) => {
              this.updateConfig(result);
              this.finishReplay();
            },
          });
        } catch (error) {
          if (errorPayload(error).code !== "DOUBAO_SESSION_NOT_FOUND") throw error;
          this.forgetSession(true);
        } finally {
          this.finishReplay();
        }
      }
      if (!this.bound) {
        await runtime.rpc.newSession(params, options, (id, result) => {
          this.sessionId = id;
          this.updateConfig(result);
        });
      }
      this.defaults ??= this.configState();
      try {
        await this.applyConfig(runtime, this.selection, signal, true);
      } catch (error) {
        await this.recoverIfLost(error);
        throw error;
      }
      signal.throwIfAborted();
      if (runtimeFailure) throw runtimeFailure;
      this.rememberConfig();
      this.attaching = false;
      this.publishConfig();
      this.publishCommands();
      this.publishLostSession();
      return runtime;
    } catch (error) {
      const failure = runtime?.withDiagnostic(error)
        ?? new DoubaoError(error instanceof Error ? error.message : String(error), "SPAWN_ERROR");
      await this.retireRuntime();
      throw runtime?.withDiagnostic(failure) ?? failure;
    } finally {
      this.attaching = false;
    }
  }

  private handleUpdate(params: RpcObject): void {
    if (params.sessionId !== this.sessionId) return;
    const update = asRecord(params.update);
    if (!update) return;
    const turn = this.turn;
    if (turn) this.armStallTimer(turn);
    const timeline = this.loadPhase === "replay" ? this.replay : this.loadPhase || !turn?.wire ? undefined : turn.timeline;
    switch (update.sessionUpdate) {
      case "available_commands_update":
        timeline?.flush();
        this.commands = mapAcpCommands(update.availableCommands);
        this.publishCommands();
        break;
      case "current_mode_update":
      case "config_option_update":
        timeline?.flush();
        this.updateConfig(update);
        if (!this.attaching && !this.operation) this.rememberConfig();
        if (!this.operation) this.publishConfig();
        break;
      default:
        timeline?.update(update, this.loadPhase === "replay");
    }
  }

  private async applyConfig(
    runtime: AcpRuntime,
    changes: Selection,
    signal: AbortSignal,
    bestEffortEffort: boolean,
  ): Promise<void> {
    const options = {
      timeoutMs: this.options.startupTimeoutMs,
      signal,
      onResult: (result: RpcObject) => this.updateConfig(result),
    };
    const target = (key: keyof Selection) => changes[key] === null ? this.defaults?.[key] : changes[key];
    const mode = target("mode");
    const model = target("model");
    let effort = target("thinkingOption");
    const sessionId = this.sessionId!;
    if (mode && mode !== this.configState().mode) {
      await runtime.rpc.request("session/set_mode", { sessionId, modeId: mode }, {
        ...options,
        onResult: (result) => {
          this.modes = { ...this.modes, currentModeId: mode };
          this.updateConfig(result);
        },
      });
    }
    if (model && model !== this.configState().model) {
      await runtime.rpc.request("session/set_config_option", { sessionId, configId: "model", value: model }, options);
    }
    if (bestEffortEffort) {
      const effortOption = selectedAcpConfigOption(this.configOptions, "effort", "thought_level");
      const values = acpOptionValues(effortOption);
      if (!effortOption || !effort || !values.includes(effort)) effort = undefined;
    }
    if (effort && effort !== this.configState().thinkingOption) {
      await runtime.rpc.request(
        "session/set_config_option",
        { sessionId, configId: "effort", value: effort },
        options,
      );
    }
  }

  private updateConfig(result: RpcObject): void {
    const modes = asRecord(result.modes);
    if (modes) this.modes = modes;
    if (typeof result.currentModeId === "string") this.modes = { ...this.modes, currentModeId: result.currentModeId };
    if (Array.isArray(result.configOptions)) this.configOptions = records(result.configOptions);
  }

  private configState() {
    return mapAcpConfig(this.modes, this.configOptions, this.options.catalog());
  }

  private rememberConfig(): void {
    const { model, mode, thinkingOption } = this.configState();
    this.selection = { model, mode, thinkingOption };
  }

  private publishConfig(): void {
    if (!this.opened || this.attaching) return;
    this.options.emit({ type: "session.config", sessionId: this.id, config: this.configState() });
  }

  private publishRuntimeFailure(error: DoubaoError): void {
    this.options.emit({ type: "session.runtime_failed", sessionId: this.id, error: errorPayload(error) });
  }

  private publishCommands(): void {
    if (!this.opened || this.attaching) return;
    this.options.emit({ type: "session.commands", sessionId: this.id, commands: this.commands });
  }

  private persistence(): ProviderPersistence | undefined {
    return this.config.persist && this.bound ? acpPersistence(this.sessionId) : undefined;
  }

  private publishPersistence(): void {
    const persistence = this.persistence();
    if (persistence) this.options.emit({ type: "session.persistence", sessionId: this.id, persistence });
  }

  private forgetSession(warn = false): void {
    const persisted = this.persistence();
    this.sessionId = null;
    this.bound = false;
    this.systemPromptPending = Boolean(this.systemPrompt);
    if (persisted) {
      if (this.opened) this.publishPersistenceClear();
      else this.persistenceCleared = true;
    }
    if (warn) {
      this.warnedLostSession = true;
      this.publishLostSession();
    }
  }

  private publishPersistenceClear(): void {
    this.persistenceCleared = false;
    this.options.emit({ type: "session.persistence", sessionId: this.id, persistence: acpPersistence(null) });
  }

  private publishLostSession(): void {
    if (!this.warnedLostSession || !this.opened || this.attaching) return;
    this.warnedLostSession = false;
    this.options.emit({
      type: "session.notice", sessionId: this.id,
      notice: {
        id: "doubao-acp-session-not-found", severity: "warning", title: "Doubao session is no longer available",
        description: "Doubao will continue in a new cloud session.",
      },
    });
  }

  private async recoverIfLost(error: unknown): Promise<void> {
    if (!this.sessionId || errorPayload(error).code !== "DOUBAO_SESSION_NOT_FOUND") return;
    this.forgetSession(true);
    await this.retireRuntime();
  }

  private finishReplay(): void {
    this.replay?.finish();
    this.replay = undefined;
    this.loadPhase = undefined;
  }

  private createTimeline(id: string): AcpTimeline {
    return new AcpTimeline(id, this.limits.maxAssistantBytes, this.limits.maxPromptBytes, (item) => this.emitItem(item));
  }

  private emitItem(item: Extract<ProviderEvent, { type: "timeline.item" }>["item"]): void {
    this.options.emit({ type: "timeline.item", sessionId: this.id, item });
  }

  private requireIdle(): void {
    if (this.closing) throw new DoubaoError("Session is closed", "CLOSED");
    if (!this.canStopRuntime()) throw new DoubaoError("Doubao session is busy", "DOUBAO_SESSION_BUSY");
  }

  private hasPendingInteraction(): boolean {
    return this.pendingPermissions.size > 0 || this.pendingElicitations.size > 0;
  }

  private exclusive(run: () => Promise<void>): Promise<void> {
    this.requireIdle();
    this.clearIdleTimer();
    this.operation = Promise.resolve().then(run).finally(() => {
      this.operation = undefined;
      this.armIdleTimer();
    });
    return this.operation;
  }

  private clearIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.runtime || this.closing || !this.canStopRuntime() || this.limits.idleRuntimeMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.retireRuntime();
    }, this.limits.idleRuntimeMs);
    this.idleTimer.unref();
  }

  private async retireRuntime(force = false): Promise<void> {
    this.clearIdleTimer();
    const runtime = this.runtime;
    if (!runtime) return this.retiring;
    this.runtime = undefined;
    this.retiring = runtime.close(force).finally(() => { this.retiring = undefined; });
    return this.retiring;
  }
}

function decodeBase64Image(data: string): Buffer | undefined {
  const compact = data.replace(/\s+/g, "");
  const maxEncodedBytes = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  if (!compact || compact.length > maxEncodedBytes || compact.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return undefined;
  }
  const encoded = compact.padEnd(compact.length + (4 - compact.length % 4) % 4, "=");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString("base64") !== encoded) {
    return undefined;
  }
  return bytes;
}

function imageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase().split(";")[0]?.trim()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    default:
      return "bin";
  }
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
