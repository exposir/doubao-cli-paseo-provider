import type { ProviderContent, ProviderPrompt } from "@getpaseo/plugin/server/provider";

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
        if (item.text.trim()) parts.push(item.text);
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

export function extractPromptText(prompt: ProviderPrompt): string {
  if (prompt.input.type === "command") {
    return `/${prompt.input.name} ${prompt.input.arguments}`.trim();
  }
  return formatPromptContent(prompt.input.content);
}
