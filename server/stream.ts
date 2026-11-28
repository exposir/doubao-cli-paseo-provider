/**
 * Parser and reducer for `doubao -p - --output-format stream-json`.
 * The CLI emits one JSON object per line:
 *   {"type":"system","subtype":"init","session_id":"..."}
 *   {"type":"stream_event","session_id":"...","message_id":"...","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"assistant","session_id":"...","message":{"id":"...","content":[{"type":"text","text":"..."}]}}
 *   {"type":"result","subtype":"success","is_error":false,"session_id":"...","result":{"type":"text","content":"..."}}
 *   {"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"...","errors":["..."],"error":{"code":"..."}}
 *
 * Everything here is pure so it can be unit-tested without the CLI.
 */

import { StringDecoder } from "node:string_decoder";
import { truncateUtf8 } from "./limits.js";

export interface PermissionDenial {
  toolName?: string;
  toolUseId?: string;
  prompt?: string;
}

export interface TurnState {
  sessionId: string | null;
  /** Active assistant message id when the CLI supplies one. */
  messageId: string | null;
  /** Text accumulated from stream deltas, replaced by the authoritative assistant message. */
  text: string;
  /** Byte length of `text`, maintained incrementally so caps stay O(chunk). */
  byteLength: number;
  /** Monotonic revision bumped on every text change so flush detection is O(1) and exact. */
  version: number;
  /** Set once the answer crossed the per-turn byte cap. */
  truncated: boolean;
  /** Final answer reported by the `result` event. */
  finalText: string | null;
  error: string | null;
  /** Structured error code from `result.error.code` (e.g. `login_required`). */
  errorCode: string | null;
  /** Cloud trace identifier supplied by result.log_id. */
  logId: string | null;
  /** Tool calls automatically denied in non-interactive `-p` mode. */
  permissionDenials: PermissionDenial[];
  done: boolean;
}

export type StreamEffect = "none" | "session" | "text" | "done" | "error";

export interface StreamOptions {
  /** Cap for the assistant text. 0 or undefined disables it. */
  maxTextBytes?: number;
}

export function createTurnState(): TurnState {
  return {
    sessionId: null,
    messageId: null,
    text: "",
    byteLength: 0,
    version: 0,
    truncated: false,
    finalText: null,
    error: null,
    errorCode: null,
    logId: null,
    permissionDenials: [],
    done: false,
  };
}

/** Reset the active assistant text buffer when a new message begins within the same turn. */
export function resetMessageBuffer(state: TurnState, messageId: string | null): void {
  state.messageId = messageId;
  state.text = "";
  state.byteLength = 0;
  state.truncated = false;
}

/** Return the assistant message id carried by a text-bearing event, if any. */
export function extractTextMessageId(event: unknown): string | null {
  const record = asRecord(event);
  if (!record || typeof record.type !== "string") return null;

  if (record.type === "stream_event") {
    const inner = asRecord(record.event);
    const delta = asRecord(inner?.delta);
    if (
      inner?.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof record.message_id === "string" &&
      record.message_id.length > 0
    ) {
      return record.message_id;
    }
    return null;
  }

  if (record.type === "assistant") {
    const message = asRecord(record.message);
    if (!message || !textFromContent(message.content)) return null;
    return typeof message.id === "string" && message.id.length > 0 ? message.id : null;
  }

  return null;
}

export class NdjsonParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly maxLineLength = Infinity) {}

  push(chunk: string | Buffer | Uint8Array): unknown[] {
    // Chunks are byte slices and can split a multi-byte character. Decoding through
    // StringDecoder keeps the split character intact instead of emitting U+FFFD.
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    const events: unknown[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      this.checkLineLength(newline);
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const parsed = tryParse(line);
        if (parsed !== undefined) events.push(parsed);
      }
      newline = this.buffer.indexOf("\n");
    }
    this.checkLineLength(this.buffer.length);
    return events;
  }

  end(): unknown[] {
    this.buffer += this.decoder.end();
    this.checkLineLength(this.buffer.length);
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    const parsed = tryParse(rest);
    return parsed === undefined ? [] : [parsed];
  }

  private checkLineLength(length: number): void {
    if (length > this.maxLineLength) throw new Error("NDJSON line exceeds the size limit");
  }
}

function tryParse(line: string): unknown | undefined {
  // Log lines such as "[cli-chat] {...}" are not protocol events.
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record && record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("");
}

function textFromResult(result: unknown): string {
  if (typeof result === "string") return result;
  const record = asRecord(result);
  if (!record) return "";
  if (typeof record.content === "string") return record.content;
  return textFromContent(record.content);
}

/** Apply one protocol event. Returns what changed so callers can throttle emissions. */
export function applyStreamEvent(
  state: TurnState,
  event: unknown,
  options: StreamOptions = {},
): StreamEffect {
  const record = asRecord(event);
  if (!record || typeof record.type !== "string") return "none";

  const maxBytes = options.maxTextBytes ?? 0;

  if (typeof record.session_id === "string" && !state.sessionId) {
    state.sessionId = record.session_id;
  }

  switch (record.type) {
    case "stream_event": {
      const inner = asRecord(record.event);
      if (!inner || inner.type !== "content_block_delta") break;
      const delta = asRecord(inner.delta);
      if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") break;
      if (typeof record.message_id === "string" && record.message_id && !state.messageId) {
        state.messageId = record.message_id;
      }
      return appendText(state, delta.text, maxBytes) ? "text" : "none";
    }

    case "assistant": {
      const message = asRecord(record.message);
      if (!message) break;
      const text = textFromContent(message.content);
      if (text) {
        if (typeof message.id === "string" && message.id && !state.messageId) {
          state.messageId = message.id;
        }
        return replaceText(state, text, maxBytes) ? "text" : "none";
      }
      break;
    }

    case "result": {
      state.done = true;
      if (typeof record.log_id === "string" && record.log_id.trim()) state.logId = record.log_id.trim();
      const denials = extractPermissionDenials(record.permission_denials);
      if (denials.length > 0) state.permissionDenials = denials;

      if (record.is_error === true) {
        const detail = summarizeResultError(record);
        state.error = detail || "Doubao CLI reported an error";
        state.errorCode = extractResultErrorCode(record);
        return "error";
      }
      const text = textFromResult(record.result);
      if (text) {
        replaceText(state, text, maxBytes);
        state.finalText = state.text;
      }
      return "done";
    }
  }

  return state.sessionId ? "session" : "none";
}

function appendText(state: TurnState, text: string, maxBytes: number): boolean {
  if (state.truncated || text.length === 0) return false;

  const bytes = Buffer.byteLength(text);
  if (maxBytes > 0 && state.byteLength + bytes > maxBytes) {
    const remaining = Math.max(0, maxBytes - state.byteLength);
    const prefix = remaining > 0 ? truncateUtf8(text, remaining) : "";
    state.text += `${prefix}\n\n[output truncated]`;
    state.truncated = true;
    state.byteLength = maxBytes;
    state.version += 1;
    return true;
  }

  state.text += text;
  state.byteLength += bytes;
  state.version += 1;
  return true;
}

function replaceText(state: TurnState, text: string, maxBytes: number): boolean {
  const bytes = Buffer.byteLength(text);
  if (maxBytes > 0 && bytes > maxBytes) {
    const next = `${truncateUtf8(text, maxBytes)}\n\n[output truncated]`;
    if (state.text === next && state.truncated) return false;
    state.text = next;
    state.byteLength = maxBytes;
    state.truncated = true;
    state.version += 1;
    return true;
  }

  if (state.text === text && !state.truncated) return false;
  state.text = text;
  state.byteLength = bytes;
  state.truncated = false;
  state.version += 1;
  return true;
}

function summarizeResultError(record: Record<string, unknown>): string {
  if (Array.isArray(record.errors)) {
    const messages = record.errors
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
    if (messages.length > 0) return messages.join("\n");
  }
  const errorObj = asRecord(record.error);
  if (errorObj && typeof errorObj.message === "string" && errorObj.message.trim()) {
    return errorObj.message.trim();
  }
  const result = asRecord(record.result);
  if (result && typeof result.content === "string" && result.content.trim()) {
    return result.content;
  }
  if (typeof record.result === "string" && record.result.trim()) return record.result;
  if (typeof record.subtype === "string") return `Doubao CLI error: ${record.subtype}`;
  return "";
}

function extractResultErrorCode(record: Record<string, unknown>): string | null {
  const errorObj = asRecord(record.error);
  if (errorObj && typeof errorObj.code === "string" && errorObj.code.trim()) {
    return errorObj.code.trim();
  }
  return null;
}

function extractPermissionDenials(value: unknown): PermissionDenial[] {
  if (!Array.isArray(value)) return [];
  const denials: PermissionDenial[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const denial: PermissionDenial = {};
    if (typeof record.tool_name === "string" && record.tool_name) denial.toolName = record.tool_name;
    if (typeof record.tool_use_id === "string" && record.tool_use_id) {
      denial.toolUseId = record.tool_use_id;
    }
    if (typeof record.prompt === "string" && record.prompt) denial.prompt = record.prompt;
    if (denial.toolName || denial.toolUseId || denial.prompt) denials.push(denial);
  }
  return denials;
}
