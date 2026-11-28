import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { asRecord, buildAcpToolItem, field, records } from "./acp-protocol.js";
import { truncateUtf8 } from "./limits.js";

type ToolItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;
type TextKind = "user_message" | "assistant_message" | "reasoning";
type Update = Record<string, unknown>;

const TEXT_FLUSH_MS = 80;
const TEXT_KINDS = new Map<string, TextKind>([
  ["user_message_chunk", "user_message"],
  ["agent_message_chunk", "assistant_message"],
  ["agent_thought_chunk", "reasoning"],
]);

/** Coalesces contiguous text chunks and retains partial tool updates for one turn or replay. */
export class AcpTimeline {
  private version = 0;
  private emittedVersion = 0;
  private sequence = 0;
  private assistantBytes = 0;
  private userBytes = 0;
  private assistantTruncated = false;
  private userTruncated = false;
  private flushTimer?: NodeJS.Timeout;
  private text?: { kind: TextKind; messageId?: string; id: string; value: string };
  private readonly tools = new Map<string, { raw: Update; item: ToolItem }>();

  constructor(
    private readonly scope: string,
    private readonly maxAssistantBytes: number,
    private readonly maxUserBytes: number,
    private readonly emit: (item: ProviderTimelineItem) => void,
  ) {}

  update(update: Update, replay = false): void {
    const type = field(update, "sessionUpdate") ?? "";
    const textKind = TEXT_KINDS.get(type);
    if (textKind) {
      if (textKind !== "user_message" || replay) this.append(textKind, update);
      return;
    }

    if (type === "tool_call" || type === "tool_call_update") {
      this.endText();
      const callId = field(update, "toolCallId");
      if (!callId) return;
      const previous = this.tools.get(callId)?.raw;
      const raw = { ...previous, ...update };
      if (update.content !== undefined && !records(update.content).some((block) => block.type === "diff")) {
        const diffs = records(previous?.content).filter((block) => block.type === "diff");
        if (diffs.length > 0) raw.content = [...diffs, ...records(update.content)];
      }
      const item = buildAcpToolItem(raw, `tool:${this.scope}:${callId}`);
      this.tools.set(callId, { raw, item });
      this.emit(item);
      return;
    }

    if (type === "plan") {
      this.endText();
      this.emit({
        type: "todo",
        id: `plan:${this.scope}`,
        items: records(update.entries).flatMap((entry) => {
          const text = field(entry, "content");
          if (!text) return [];
          const status = entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending";
          return [{ text, status, completed: status === "completed" }];
        }),
      });
    }
  }

  finish(state?: "completed" | "canceled" | "failed"): void {
    this.endText();
    if (state) {
      for (const { item } of this.tools.values()) {
        if (item.status !== "running") continue;
        if (state === "failed") {
          this.emit({ ...item, status: "failed", error: { message: "Doubao turn failed" } });
        } else {
          this.emit({ ...item, status: "canceled", error: null });
        }
      }
    }
    this.tools.clear();
  }

  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.text || this.version === this.emittedVersion) return;
    const { kind, id, value, messageId } = this.text;
    this.emittedVersion = this.version;
    if (kind === "reasoning") this.emit({ type: kind, id, text: value });
    else this.emit({ type: kind, id, text: value, messageId });
  }

  private endText(): void {
    this.flush();
    this.text = undefined;
  }

  private append(kind: TextKind, update: Update): void {
    const content = asRecord(update.content);
    const chunk = content?.type === "text" ? field(content, "text") : undefined;
    if (!chunk) return;
    const messageId = field(update, "messageId", "message_id");
    if (kind !== this.text?.kind || messageId !== this.text?.messageId) this.endText();

    const user = kind === "user_message";
    if (user ? this.userTruncated : this.assistantTruncated) return;
    const max = user ? this.maxUserBytes : this.maxAssistantBytes;
    const used = user ? this.userBytes : this.assistantBytes;
    const bytes = Buffer.byteLength(chunk);
    const truncated = max > 0 && used + bytes > max;
    const text = truncated ? truncateUtf8(chunk, max - used) + "\n[truncated]" : chunk;
    if (user) {
      this.userBytes += bytes;
      this.userTruncated = truncated;
    } else {
      this.assistantBytes += bytes;
      this.assistantTruncated = truncated;
    }
    this.text ??= { kind, messageId, id: `${kind}:${this.scope}:${++this.sequence}`, value: "" };
    this.text.value += text;
    this.version += 1;
    this.flushTimer ??= setTimeout(() => this.flush(), TEXT_FLUSH_MS);
  }
}
