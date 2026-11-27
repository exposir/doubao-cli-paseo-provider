import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

type ToolCallItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

export interface ToolCall {
  kind: "call";
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  kind: "result";
  callId: string;
  isError: boolean;
  output: string;
}

export type ToolEvent = ToolCall | ToolResult;

/** Pull tool_use / tool_result blocks out of one stream-json event. */
export function extractToolEvents(event: unknown): ToolEvent[] {
  const record = asRecord(event);
  if (!record) return [];

  if (record.type === "assistant") {
    const message = asRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) return [];

    const events: ToolEvent[] = [];
    for (const block of content) {
      const item = asRecord(block);
      if (item?.type !== "tool_use" || typeof item.id !== "string" || typeof item.name !== "string") {
        continue;
      }
      events.push({
        kind: "call",
        callId: item.id,
        name: item.name,
        input: asRecord(item.input) ?? {},
      });
    }
    return events;
  }

  if (record.type === "user") {
    const message = asRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) return [];

    const events: ToolEvent[] = [];
    for (const block of content) {
      const item = asRecord(block);
      if (item?.type !== "tool_result" || typeof item.tool_use_id !== "string") continue;
      events.push({
        kind: "result",
        callId: item.tool_use_id,
        isError: item.is_error === true,
        output: textOf(item.content),
      });
    }
    return events;
  }

  return [];
}

/** Build (or update) the timeline item for one tool call. */
export function buildToolItem(call: ToolCall, result?: ToolResult): ToolCallItem {
  const state = result ? (result.isError ? "failed" : "completed") : "running";
  const item = {
    id: `tool:${call.callId}`,
    type: "tool_call" as const,
    callId: call.callId,
    name: call.name,
    detail: toolDetail(call.name, call.input, result),
    status: state,
    error: state === "failed" ? { message: result?.output ?? "Tool failed" } : null,
  };

  return item as ToolCallItem;
}

function toolDetail(
  name: string,
  input: Record<string, unknown>,
  result?: ToolResult,
): ProviderToolCallDetail {
  const key = name.toLowerCase();
  const output = result?.output;
  const filePath = str(input.file_path) ?? str(input.path) ?? str(input.filePath);

  if (key.includes("bash") || key.includes("shell") || key.includes("exec")) {
    return {
      type: "shell",
      command: str(input.command) ?? str(input.cmd) ?? name,
      cwd: str(input.cwd),
      output,
      exitCode: parseExitCode(output),
    };
  }

  if (key === "read" || key.includes("read_file")) {
    return { type: "read", filePath: filePath ?? "", content: output };
  }

  if (key === "write" || key.includes("write_file")) {
    return {
      type: "write",
      filePath: filePath ?? "",
      content: str(input.content) ?? str(input.file_text),
    };
  }

  if (key.includes("edit") || key.includes("replace") || key.includes("patch")) {
    return {
      type: "edit",
      filePath: filePath ?? "",
      oldString: str(input.old_string) ?? str(input.old_str),
      newString: str(input.new_string) ?? str(input.new_str),
      unifiedDiff: looksLikeDiff(output) ? output : undefined,
    };
  }

  if (key.includes("glob") || key.includes("grep") || key.includes("search")) {
    return {
      type: "search",
      query: str(input.pattern) ?? str(input.query) ?? str(input.glob) ?? name,
      toolName: key.includes("glob") ? "glob" : key.includes("grep") ? "grep" : "search",
      content: output,
    };
  }

  if (key.includes("fetch") || key.includes("http")) {
    return { type: "fetch", url: str(input.url) ?? "", result: output };
  }

  return { type: "unknown", input, output: output ?? null } as unknown as ProviderToolCallDetail;
}

function parseExitCode(output: string | undefined): number | null | undefined {
  if (!output) return undefined;
  const match = output.match(/exited with code (-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function looksLikeDiff(output: string | undefined): boolean {
  if (!output) return false;
  return output.includes("diff --git") || output.includes("@@");
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part);
        return typeof record?.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
