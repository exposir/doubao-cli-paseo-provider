import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { DoubaoError } from "./errors.js";

/**
 * Doubao's headless mode takes one string. Attachments Paseo can send that the CLI
 * cannot consume directly are rendered as readable context blocks instead of being
 * silently dropped.
 */
export function formatPromptContent(content: readonly ProviderContent[]): string {
  const parts: string[] = [];

  for (const item of content) {
    switch (item.type) {
      case "text":
        if (item.text.trim()) {
          const header = textAttachmentHeader(item);
          parts.push(header ? `${header}\n${item.text}` : item.text);
        }
        break;

      case "image":
        parts.push(`[Image attachment: ${item.mimeType}]`);
        break;

      case "uploaded_file":
        parts.push(`[Attached file: ${item.fileName} (${item.path})]`);
        break;

      case "github_pr":
      case "forge_change_request":
        parts.push(
          [
            `[Pull request #${item.number}: ${item.title}]`,
            `URL: ${item.url}`,
            item.baseRefName ? `Base: ${item.baseRefName}` : "",
            item.headRefName ? `Head: ${item.headRefName}` : "",
            item.body ?? "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        break;

      case "github_issue":
      case "forge_issue":
        parts.push(
          [`[Issue #${item.number}: ${item.title}]`, `URL: ${item.url}`, item.body ?? ""]
            .filter(Boolean)
            .join("\n"),
        );
        break;

      case "review": {
        const comments = item.comments
          .map((comment) => `- ${comment.filePath}:${comment.lineNumber} (${comment.side}): ${comment.body}`)
          .join("\n");
        parts.push(`[Code review, mode: ${item.mode}]\n${comments}`);
        break;
      }
    }
  }

  return parts.join("\n\n").trim();
}

function textAttachmentHeader(
  item: Extract<ProviderContent, { type: "text" }>,
): string | null {
  const resource = "externalResource" in item ? item.externalResource : undefined;
  if (!resource) {
    const title = "title" in item && typeof item.title === "string" ? item.title.trim() : "";
    return title ? `[Text attachment: ${title}]` : null;
  }
  const title = resource.title.trim() || resource.identifier.trim();
  const label = resource.providerLabel.trim() || resource.provider.trim();
  const details = [label, title].filter(Boolean).join(": ");
  return `[External resource${details ? `: ${details}` : ""}${resource.url ? ` (${resource.url})` : ""}]`;
}

export function extractPromptText(prompt: ProviderPrompt): string {
  if (prompt.input.type === "command") {
    return `/${prompt.input.name} ${prompt.input.arguments}`.trim();
  }
  return formatPromptContent(prompt.input.content);
}

/** The CLI rejects a final prompt above 262,144 Unicode code points. */
export const MAX_PROMPT_CODE_POINTS = 262_144;

export function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function validatePromptText(text: string, maxBytes: number): void {
  if (!text) throw new DoubaoError("Prompt is empty", "EMPTY_PROMPT");
  const codePoints = countCodePoints(text);
  if (codePoints > MAX_PROMPT_CODE_POINTS) {
    throw new DoubaoError(
      `Prompt is ${codePoints} code points; the limit is ${MAX_PROMPT_CODE_POINTS}`,
      "PROMPT_TOO_LARGE",
    );
  }
  const bytes = Buffer.byteLength(text);
  if (maxBytes > 0 && bytes > maxBytes) {
    throw new DoubaoError(
      `Prompt is ${bytes} bytes; the limit is ${maxBytes}`,
      "PROMPT_TOO_LARGE",
    );
  }
}
