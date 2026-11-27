export class DoubaoError extends Error {
  public readonly code: string;

  constructor(message: string, code = "DOUBAO_ERROR") {
    super(message);
    this.name = "DoubaoError";
    this.code = code;
  }
}

export function errorPayload(error: unknown): { message: string; code: string } {
  if (error instanceof DoubaoError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: "DOUBAO_ERROR" };
  }
  return { message: String(error), code: "DOUBAO_ERROR" };
}

/** Trim CLI stderr to something a timeline can render. */
export function summarizeStderr(stderr: string, limit = 2000): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[cli-chat]"));
  const text = lines.join("\n").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
