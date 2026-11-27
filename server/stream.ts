/**
 * Parser and reducer for `doubao -p ... --output-format stream-json`.
 * The CLI emits one JSON object per line:
 *   {"type":"system","subtype":"init","session_id":"..."}
 *   {"type":"stream_event","session_id":"...","message_id":"...","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"assistant","session_id":"...","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"result","subtype":"success","is_error":false,"session_id":"...","result":{"type":"text","content":"..."}}
 *
 * Everything here is pure so it can be unit-tested without the CLI.
 */

import { StringDecoder } from "node:string_decoder";

export interface TurnState {
  sessionId: string | null;
  /** Text accumulated from stream deltas, replaced by the authoritative assistant message. */
  text: string;
  /** Final answer reported by the `result` event. */
  finalText: string | null;
  error: string | null;
  done: boolean;
}

export type StreamEffect = "none" | "session" | "text" | "done" | "error";

export function createTurnState(): TurnState {
  return { sessionId: null, text: "", finalText: null, error: null, done: false };
}

export class NdjsonParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: string | Buffer | Uint8Array): unknown[] {
    // Chunks are byte slices and can split a multi-byte character. Decoding through
    // StringDecoder keeps the split character intact instead of emitting U+FFFD.
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    const events: unknown[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const parsed = tryParse(line);
        if (parsed !== undefined) events.push(parsed);
      }
      newline = this.buffer.indexOf("\n");
    }
    return events;
  }

  end(): unknown[] {
    this.buffer += this.decoder.end();
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    const parsed = tryParse(rest);
    return parsed === undefined ? [] : [parsed];
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
export function applyStreamEvent(state: TurnState, event: unknown): StreamEffect {
  const record = asRecord(event);
  if (!record || typeof record.type !== "string") return "none";

  if (typeof record.session_id === "string" && !state.sessionId) {
    state.sessionId = record.session_id;
  }

  switch (record.type) {
    case "stream_event": {
      const inner = asRecord(record.event);
      if (!inner || inner.type !== "content_block_delta") break;
      const delta = asRecord(inner.delta);
      if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") break;
      state.text += delta.text;
      return "text";
    }

    case "assistant": {
      const message = asRecord(record.message);
      if (!message) break;
      const text = textFromContent(message.content);
      if (text) {
        state.text = text;
        return "text";
      }
      break;
    }

    case "result": {
      state.done = true;
      if (record.is_error === true) {
        const detail = summarizeResultError(record);
        state.error = detail || "Doubao CLI reported an error";
        return "error";
      }
      const text = textFromResult(record.result);
      if (text) {
        state.finalText = text;
        state.text = text;
      }
      return "done";
    }
  }

  return state.sessionId ? "session" : "none";
}

function summarizeResultError(record: Record<string, unknown>): string {
  const result = asRecord(record.result);
  if (result && typeof result.content === "string") return result.content;
  if (typeof record.result === "string") return record.result;
  if (typeof record.subtype === "string") return `Doubao CLI error: ${record.subtype}`;
  return "";
}
