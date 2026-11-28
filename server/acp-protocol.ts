import type { Readable, Writable } from "node:stream";
import type {
  ProviderCatalog,
  ProviderCommand,
  ProviderConfigState,
  ProviderMode,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPrompt,
  ProviderContent,
  ProviderSessionConfig,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { DoubaoError } from "./errors.js";
import { truncateUtf8 } from "./limits.js";
import { formatPromptContent } from "./prompt.js";
import { NdjsonParser } from "./stream.js";

type RpcObject = Record<string, unknown>;
type RpcId = string | number;
type ToolItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;
type JsonValue = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];

const MAX_LINE_LENGTH = 8 * 1024 * 1024;
const MAX_EARLY_UPDATES = 4096;
const MAX_TOOL_BYTES = 64 * 1024;
const MAX_PERMISSION_DESCRIPTION_CHARS = 240;
const TRUNCATED = "\n[truncated]";
const BUILTIN_ACP_COMMANDS = new Set(["init", "review", "compact", "agent-new"]);

export type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string };

interface AcpPromptFormatOptions {
  image?(item: Extract<ProviderContent, { type: "image" }>): string;
  uploadedFile?(item: Extract<ProviderContent, { type: "uploaded_file" }>): AcpPromptBlock | undefined;
}

export interface AcpPromptRender {
  blocks: AcpPromptBlock[];
  text: string;
}

type AcpQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; value: string }>;
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  freeText: boolean;
};

export interface AcpElicitationSpec {
  request: ProviderPermissionRequest;
  questions: AcpQuestion[];
}

export type AcpElicitationResponse =
  | { action: "cancel" }
  | { action: "accept"; content: Record<string, string | string[]> };

export const ACP_MODES: readonly ProviderMode[] = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
  { id: "bypass_permissions", label: "Bypass permissions", isUnattended: true },
];

export function asRecord(value: unknown): RpcObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RpcObject
    : undefined;
}

export function records(value: unknown): RpcObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const record = asRecord(entry);
    return record ? [record] : [];
  });
}

export function field(record: RpcObject | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function selectedAcpConfigOption(
  options: readonly RpcObject[],
  id: string,
  category: string,
): RpcObject | undefined {
  return options.find((option) => option.id === id && option.category === category)
    ?? options.find((option) => option.id === id)
    ?? options.find((option) => option.category === category);
}

export function acpOptionValues(option: RpcObject | undefined): string[] {
  return records(option?.options).flatMap((choice) => {
    const choices = "options" in choice ? records(choice.options) : [choice];
    return choices.flatMap((entry) => {
      const value = field(entry, "value");
      return value ? [value] : [];
    });
  });
}

const ACP_ERROR_CODES = new Map([
  [-32000, "DOUBAO_LOGIN_REQUIRED"],
  [-32002, "DOUBAO_SESSION_NOT_FOUND"],
  [-32602, "DOUBAO_INVALID_ARGUMENTS"],
  [-32901, "DOUBAO_SESSION_BUSY"],
  [-32800, "DOUBAO_REQUEST_CANCELLED"],
  [-32603, "DOUBAO_INTERNAL_ERROR"],
]);

export function mapAcpError(error: unknown): DoubaoError {
  const record = asRecord(error);
  const code = typeof record?.code === "number" ? record.code : undefined;
  const message = field(record, "message") || "Doubao ACP request failed";
  return new DoubaoError(message, ACP_ERROR_CODES.get(code ?? 0) ?? "DOUBAO_ACP_ERROR");
}

export interface AcpResponder {
  result(value: RpcObject): void;
  error(code: number, message: string): void;
}

interface ClientHandlers {
  notification?(method: string, params: RpcObject): void;
  request?(method: string, params: RpcObject, reply: AcpResponder): void;
  protocolError?(error: DoubaoError): void;
}

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onResult?: (result: RpcObject) => void;
}

interface PendingRequest {
  finish(error: unknown, result?: RpcObject): void;
}

/** A bidirectional JSON-RPC connection over Doubao's newline-delimited stdio. */
export class AcpJsonRpcClient {
  private readonly parser = new NdjsonParser(MAX_LINE_LENGTH);
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private failure?: DoubaoError;
  private earlyUpdates?: { frames: RpcObject[]; bytes: number };

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: ClientHandlers = {},
  ) {
    input.on("data", (chunk: Buffer) => this.read(() => this.parser.push(chunk)));
    input.once("end", () => this.read(() => this.parser.end()));
    input.on("error", (error: Error) => this.protocolError(error));
    // A CLI that exits can close its stdin before all stderr reaches the runtime.
    output.on("error", () => {});
  }

  request(method: string, params: RpcObject, options: RequestOptions = {}): Promise<RpcObject> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const { signal, timeoutMs, onResult } = options;
      if (signal?.aborted) return reject(signal.reason);

      const id = ++this.nextId;
      const abort = () => finish(signal?.reason ?? new DoubaoError("Request aborted", "DOUBAO_REQUEST_CANCELLED"));
      const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => {
        finish(new DoubaoError(`Doubao ACP ${method} timed out after ${timeoutMs} ms`, "ACP_REQUEST_TIMEOUT"));
      }, timeoutMs) : undefined;
      const finish = (error: unknown, result?: RpcObject) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!result) return reject(error);
        try {
          // Apply local state before dispatching the next line in the same read.
          onResult?.(result);
          resolve(result);
        } catch (cause) {
          reject(cause);
        }
      };

      this.pending.set(id, { finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.write({ id, method, params });
      } catch (error) {
        finish(error);
      }
    });
  }

  async newSession(
    params: RpcObject,
    options: RequestOptions,
    onSession: (id: string, result: RpcObject) => void,
  ): Promise<void> {
    if (this.earlyUpdates) throw new DoubaoError("ACP session/new is already pending", "DOUBAO_SESSION_BUSY");
    const early = { frames: [] as RpcObject[], bytes: 0 };
    this.earlyUpdates = early;
    try {
      await this.request("session/new", params, {
        ...options,
        onResult: (result) => {
          const id = field(result, "sessionId");
          if (!id) throw new DoubaoError("ACP session/new returned no session ID", "ACP_PROTOCOL_ERROR");
          this.earlyUpdates = undefined;
          onSession(id, result);
          for (const frame of early.frames) {
            if (frame.sessionId === id) this.handlers.notification?.("session/update", frame);
          }
        },
      });
    } finally {
      if (this.earlyUpdates === early) this.earlyUpdates = undefined;
    }
  }

  notify(method: string, params: RpcObject): void {
    this.write({ method, params });
  }

  fail(error: DoubaoError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.finish(error);
    this.earlyUpdates = undefined;
  }

  private write(message: RpcObject): void {
    if (this.failure || this.output.destroyed || this.output.writableEnded) return;
    this.output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private read(parse: () => unknown[]): void {
    if (this.failure) return;
    try {
      for (const frame of parse()) {
        if (this.failure) break;
        const message = asRecord(frame);
        if (message?.jsonrpc === "2.0") this.dispatch(message);
      }
    } catch (error) {
      this.protocolError(error);
    }
  }

  private protocolError(error: unknown): void {
    if (this.failure) return;
    const failure = new DoubaoError(error instanceof Error ? error.message : String(error), "ACP_PROTOCOL_ERROR");
    this.fail(failure);
    this.handlers.protocolError?.(failure);
  }

  private dispatch(message: RpcObject): void {
    const { id, method } = message;
    if (typeof method === "string") {
      const params = asRecord(message.params) ?? {};
      if (typeof id === "string" || typeof id === "number") {
        this.reverseRequest(id, method, params);
      } else if (id === undefined) {
        const early = this.earlyUpdates;
        if (method === "session/update" && early) {
          early.bytes += Buffer.byteLength(JSON.stringify(params));
          if (early.bytes > MAX_LINE_LENGTH || early.frames.length >= MAX_EARLY_UPDATES) {
            throw new Error("Too many ACP updates before session/new completed");
          }
          early.frames.push(params);
        } else {
          this.handlers.notification?.(method, params);
        }
      }
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    const result = asRecord(message.result);
    if ("error" in message) pending.finish(mapAcpError(message.error));
    else if (result) pending.finish(null, result);
    else pending.finish(new DoubaoError("Invalid ACP response", "ACP_PROTOCOL_ERROR"));
  }

  private reverseRequest(id: RpcId, method: string, params: RpcObject): void {
    let replied = false;
    const send = (message: RpcObject) => {
      if (replied) return;
      replied = true;
      this.write({ id, ...message });
    };
    const reply: AcpResponder = {
      result: (result) => send({ result }),
      error: (code, message) => send({ error: { code, message } }),
    };
    try {
      if (this.handlers.request) this.handlers.request(method, params, reply);
      else reply.error(-32601, "Method not found");
    } catch (error) {
      reply.error(-32603, error instanceof Error ? error.message : String(error));
    }
  }
}

export function formatAcpPrompt(
  prompt: ProviderPrompt,
  options: AcpPromptFormatOptions = {},
): AcpPromptRender {
  if (prompt.input.type === "command") {
    const text = `/${prompt.input.name} ${prompt.input.arguments}`.trim();
    return text ? { blocks: [{ type: "text", text }], text } : { blocks: [], text: "" };
  }

  const blocks: AcpPromptBlock[] = [];
  const textParts: string[] = [];
  let pendingText: string[] = [];

  const flush = () => {
    const text = pendingText.join("\n\n").trim();
    if (text) blocks.push({ type: "text", text });
    pendingText = [];
  };

  for (const item of prompt.input.content) {
    if (item.type === "uploaded_file") {
      const link = options.uploadedFile?.(item);
      if (link) {
        flush();
        blocks.push(link);
      }
      const fallback = `[Uploaded file: ${item.fileName} (${item.path})]`;
      if (!link) pendingText.push(fallback);
      textParts.push(fallback);
      continue;
    }

    const rendered = item.type === "image"
      ? options.image?.(item) ?? `[Attached image (${item.mimeType})]`
      : formatPromptContent([item]);
    if (rendered) {
      pendingText.push(rendered);
      textParts.push(rendered);
    }
  }
  flush();
  return { blocks, text: textParts.join("\n\n").trim() };
}

export function formatAcpPromptBlocks(
  prompt: ProviderPrompt,
  options: AcpPromptFormatOptions = {},
): AcpPromptBlock[] {
  return formatAcpPrompt(prompt, options).blocks;
}

export function toAcpMcpServers(servers: ProviderSessionConfig["mcpServers"]): RpcObject[] {
  const pairs = (values?: Record<string, string>) =>
    Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));
  return Object.entries(servers).map(([name, server]) => server.type === "stdio"
    ? { name, command: server.command, args: server.args ?? [], env: pairs(server.env) }
    : { type: server.type, name, url: server.url, headers: pairs(server.headers) });
}

export function mapAcpConfig(
  modes: RpcObject | undefined,
  options: unknown,
  catalog: ProviderCatalog,
): ProviderConfigState {
  const config = records(options);
  const model = selectedAcpConfigOption(config, "model", "model");
  const effort = selectedAcpConfigOption(config, "effort", "thought_level");
  const modelId = field(model, "currentValue") ?? catalog.defaultModel;
  const modelChoices = selectChoices(model);
  const effortChoices = selectChoices(effort);
  const effortId = field(effort, "currentValue");
  const thinkingOption = effort ? effortId : undefined;
  const catalogModel = catalog.models.find((entry) => entry.id === modelId);
  const modeChoices = records(modes?.availableModes).flatMap((mode): ProviderMode[] => {
    const id = field(mode, "id");
    if (!id) return [];
    return [{
      id,
      label: field(mode, "name") || id,
      description: field(mode, "description"),
      ...(id === "bypass_permissions" ? { isUnattended: true } : {}),
    }];
  });
  return {
    model: modelId,
    mode: field(modes, "currentModeId") ?? catalog.defaultMode,
    thinkingOption,
    models: modelChoices.length > 0 ? modelChoices.map((choice) => ({
      ...catalog.models.find((entry) => entry.id === choice.id),
      ...choice,
      ...(choice.id === modelId && effortChoices.length > 0
        ? { thinkingOptions: effortChoices, defaultThinkingOptionId: catalogModel?.defaultThinkingOptionId }
        : {}),
    })) : catalog.models,
    modes: modeChoices.length > 0 ? modeChoices : catalog.modes,
    thinkingOptions: effortChoices,
    settings: [],
  };
}

function selectChoices(option: RpcObject | undefined) {
  return records(option?.options).flatMap((choice) => {
    const options = "options" in choice ? records(choice.options) : [choice];
    return options.flatMap((entry) => {
      const id = field(entry, "value");
      return id ? [{ id, label: field(entry, "name") || id, description: field(entry, "description") }] : [];
    });
  });
}

export function mapAcpCommands(value: unknown): ProviderCommand[] {
  return records(value).flatMap((command) => {
    const name = field(command, "name")?.replace(/^\//, "");
    const kind = command.kind === "skill" || command.kind === "command"
      ? command.kind
      : name && BUILTIN_ACP_COMMANDS.has(name) ? "command" : "skill";
    return name ? [{
      name,
      description: field(command, "description") ?? "",
      argumentHint: field(asRecord(command.input), "hint"),
      kind,
    }] : [];
  });
}

export function buildAcpToolItem(call: RpcObject, id: string): ToolItem {
  const callId = field(call, "toolCallId") ?? id;
  const name = field(call, "title", "name") || "Tool";
  const input = asRecord(call.rawInput);
  const rawOutput = asRecord(call.rawOutput);
  const locations = records(call.locations).flatMap((location) => {
    const path = field(location, "path");
    return path ? [{ path, ...(typeof location.line === "number" ? { line: location.line } : {}) }] : [];
  });
  const blocks = records(call.content);
  const contentText = blocks.flatMap((block) => {
    const content = asRecord(block.content);
    return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
  }).join("\n");
  const output = capToolText(contentText || outputText(call.rawOutput));
  const diff = blocks.find((block) => block.type === "diff");
  const inputPath = field(input, "filePath", "file_path", "path", "file");
  const filePath = field(diff, "path") ?? inputPath ?? locations[0]?.path ?? "";
  if (locations.length === 0 && filePath) locations.push({ path: filePath });
  const kind = toolKind(field(call, "kind"), name, input);
  const readPath = kind === "read" && !filePath ? field(call, "title") ?? "" : filePath;
  const shellCommand = field(input, "command", "cmd") || name;
  const shellArgs = Array.isArray(input?.args)
    ? input.args.flatMap((value) => typeof value === "string" ? [value] : [])
    : [];
  const command = shellArgs.length > 0 ? `${shellCommand} ${shellArgs.join(" ")}` : shellCommand;

  let detail: ProviderToolCallDetail;
  switch (kind) {
    case "shell":
      detail = {
        type: kind, command, cwd: field(input, "cwd"), output,
        exitCode: numeric(rawOutput, "exitCode", "exit_code"),
      };
      break;
    case "read":
      detail = {
        type: kind, filePath: readPath, content: output,
        offset: numeric(input, "offset", "line"), limit: numeric(input, "limit"),
      };
      break;
    case "write":
      detail = { type: kind, filePath, content: capToolText(field(input, "content", "file_text", "text") ?? field(diff, "newText")) };
      break;
    case "edit":
      detail = {
        type: kind, filePath,
        oldString: capToolText(field(diff, "oldText") ?? field(input, "oldString", "old_string", "old_str")),
        newString: capToolText(field(diff, "newText") ?? field(input, "newString", "new_string", "new_str")
          ?? (call.kind === "delete" ? "" : undefined)),
        unifiedDiff: capToolText(field(diff, "diff") ?? field(input, "unifiedDiff", "diff")
          ?? field(rawOutput, "unifiedDiff", "diff") ?? (output?.includes("@@") ? output : undefined)),
      };
      break;
    case "search":
      detail = { type: kind, query: field(input, "query", "pattern", "glob") || name, content: output, filePaths: locations.map(({ path }) => path) };
      break;
    case "fetch":
      detail = { type: kind, url: field(input, "url") || name, prompt: field(input, "prompt"), result: output, code: numeric(rawOutput, "status", "code") };
      break;
    case "think":
      detail = { type: "plain_text", label: name, icon: "brain", text: output };
      break;
    case "switch_mode":
      detail = { type: "plain_text", label: name, icon: "sparkles", text: output };
      break;
    default:
      detail = { type: "unknown", input: boundedJson(call.rawInput), output: contentText ? output ?? null : boundedJson(call.rawOutput) };
  }
  const base = { type: "tool_call" as const, id, callId, name, detail, metadata: { locations } };
  if (call.status === "failed") return { ...base, status: "failed", error: { message: output || "Tool failed" } };
  const status = call.status === "completed" ? "completed"
    : call.status === "cancelled" || call.status === "canceled" ? "canceled" : "running";
  return { ...base, status, error: null };
}

function toolKind(kind: string | undefined, name: string, input: RpcObject | undefined): string {
  if (kind === "execute") return "shell";
  if (kind === "delete") return "edit";
  if (kind === "edit" && /^(write|create)/i.test(name)) return "write";
  if (kind && kind !== "other") return kind;
  if (field(input, "command", "cmd") || /bash|shell|exec/i.test(name)) return "shell";
  if (/edit|replace|patch/i.test(name)) return "edit";
  if (/^read/i.test(name)) return "read";
  if (/^(write|create)/i.test(name)) return "write";
  if (/search|grep|glob/i.test(name)) return "search";
  if (/fetch/i.test(name)) return "fetch";
  return "unknown";
}

function capToolText(value: string | undefined): string | undefined {
  if (value === undefined || Buffer.byteLength(value) <= MAX_TOOL_BYTES) return value;
  return truncateUtf8(value, MAX_TOOL_BYTES - Buffer.byteLength(TRUNCATED)) + TRUNCATED;
}

function boundedJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (!serialized) return null;
  return Buffer.byteLength(serialized) <= MAX_TOOL_BYTES
    ? value as JsonValue
    : capToolText(serialized) ?? null;
}

function outputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value == null) return undefined;
  return field(asRecord(value), "output", "text", "content", "result") ?? JSON.stringify(value);
}

function numeric(record: RpcObject | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function buildAcpPermissionRequest(id: string, params: RpcObject): ProviderPermissionRequest {
  const call = asRecord(params.toolCall) ?? {};
  const tool = buildAcpToolItem(call, id);
  const description = permissionDescription(tool.detail, call);
  const normalizedName = collapseWhitespace(tool.name);
  return {
    id,
    kind: "tool",
    name: tool.name,
    title: field(call, "title"),
    ...(description && description !== normalizedName ? { description } : {}),
    detail: tool.detail,
    input: asRecord(boundedJson(call.rawInput)) as ProviderPermissionRequest["input"],
    actions: records(params.options).flatMap((option) => {
      const optionId = field(option, "optionId");
      const kind = field(option, "kind");
      if (!optionId || !kind || !["allow_once", "allow_always", "reject_once", "reject_always"].includes(kind)) return [];
      return [{
        id: optionId,
        label: field(option, "name") || optionId,
        behavior: kind.startsWith("allow_") ? "allow" : "deny",
      }];
    }),
  };
}

export function buildAcpElicitationRequest(id: string, params: RpcObject): AcpElicitationSpec {
  const schema = asRecord(params.requestedSchema);
  const properties = asRecord(schema?.properties) ?? {};
  const required = Array.isArray(schema?.required)
    ? new Set(schema.required.flatMap((value) => typeof value === "string" ? [value] : []))
    : new Set<string>();
  const usedHeaders = new Set<string>();
  const questions = Object.entries(properties).flatMap(([qid, rawProperty]): AcpQuestion[] => {
    if (qid.endsWith(":text")) return [];
    const property = asRecord(rawProperty);
    if (!property) return [];
    const question = field(property, "title") || qid;
    const header = uniqueQuestionHeader(question || qid, usedHeaders);
    const companion = asRecord(properties[`${qid}:text`]);
    const allowOther = Boolean(companion && companion.type === "string");
    const optionRecords = property.type === "array"
      ? records(asRecord(property.items)?.anyOf)
      : records(property.oneOf);
    const options = optionRecords.flatMap((option) => {
      const value = field(option, "const");
      return value ? [{ value, label: field(option, "title") || value }] : [];
    });
    const multiSelect = property.type === "array";
    const freeText = property.type === "string" && optionRecords.length === 0;
    if (property.type !== "string" && !multiSelect) return [];
    return [{
      id: qid,
      header,
      question,
      options,
      multiSelect,
      allowOther,
      allowEmpty: !required.has(qid),
      freeText,
    }];
  });
  const message = field(params, "message")?.trim() || "Doubao needs your input";
  const authorized = collapseWhitespace(questions.map(({ question }) => question).join("; "));
  const description = capText(authorized, MAX_PERMISSION_DESCRIPTION_CHARS);
  return {
    questions,
    request: {
      id,
      kind: "question",
      name: "AskUserQuestion",
      title: message,
      ...(description ? { description } : {}),
      input: {
        questions: questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map(({ label }) => ({ label, description: "" })),
          multiSelect: question.multiSelect,
          allowOther: question.allowOther,
          allowEmpty: question.allowEmpty,
        })),
      },
    },
  };
}

export function buildAcpElicitationResponse(
  spec: AcpElicitationSpec,
  response: ProviderPermissionResponse,
): AcpElicitationResponse {
  if (response.behavior !== "allow") return { action: "cancel" };
  const answers = asRecord(response.updatedInput?.answers);
  if (!answers) return { action: "cancel" };
  const content: Record<string, string | string[]> = {};

  for (const question of spec.questions) {
    const rawAnswer = field(answers, question.header) ?? field(answers, question.id);
    if (rawAnswer === undefined) {
      if (question.allowEmpty) continue;
      return { action: "cancel" };
    }
    if (!rawAnswer.trim()) {
      if (question.allowEmpty) continue;
      return { action: "cancel" };
    }
    if (question.freeText) {
      content[question.id] = rawAnswer;
      continue;
    }
    if (!question.multiSelect) {
      const answer = rawAnswer.trim();
      const match = question.options.find(({ label, value }) => label === answer || value === answer);
      if (match) {
        content[question.id] = match.value;
      } else if (question.allowOther) {
        content[`${question.id}:text`] = rawAnswer;
      } else {
        return { action: "cancel" };
      }
      continue;
    }

    const values = rawAnswer.split(",").map((value) => value.trim()).filter(Boolean);
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const value of values) {
      const match = question.options.find((option) => option.label === value || option.value === value);
      if (match) {
        if (!matched.includes(match.value)) matched.push(match.value);
      } else {
        unmatched.push(value);
      }
    }
    if (matched.length === 0 && unmatched.length > 0 && !question.allowOther) {
      return { action: "cancel" };
    }
    content[question.id] = matched;
    if (unmatched.length > 0 && question.allowOther) {
      content[`${question.id}:text`] = unmatched.join(", ");
    }
  }
  return { action: "accept", content };
}

function permissionDescription(detail: ProviderToolCallDetail, call: RpcObject): string | undefined {
  let value: string | undefined;
  switch (detail.type) {
    case "shell":
      value = detail.command;
      break;
    case "read":
    case "write":
    case "edit":
      value = detail.filePath;
      break;
    case "fetch":
      value = detail.url;
      break;
    case "search":
      value = detail.query;
      break;
  }
  let normalized = value ? collapseWhitespace(value) : "";
  if (!normalized) normalized = collapseWhitespace(firstPermissionContent(call) ?? "");
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length <= MAX_PERMISSION_DESCRIPTION_CHARS
    ? normalized
    : `${chars.slice(0, MAX_PERMISSION_DESCRIPTION_CHARS - 3).join("")}...`;
}

function firstPermissionContent(call: RpcObject): string | undefined {
  for (const block of records(call.content)) {
    const content = asRecord(block.content);
    let text: string | undefined;
    if (content?.type === "text") text = field(content, "text");
    else if (block.type === "text") text = field(block, "text");
    if (text?.trim()) return text;
  }
  return undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function capText(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars - 3).join("")}...`;
}

function uniqueQuestionHeader(value: string, used: Set<string>): string {
  const base = value.trim() || "Question";
  let header = base;
  let suffix = 2;
  while (used.has(header)) header = `${base} (${suffix++})`;
  used.add(header);
  return header;
}
