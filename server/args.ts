export interface TurnArgsInput {
  /** Native session to continue, when the provider already learned one. */
  sessionId?: string | null;
  text: string;
  cwd?: string;
  /** Catalogue model id (not the display name). */
  model?: string;
  thinkingOption?: string;
  mode?: string;
}

/**
 * `doubao [-C dir] [--resume id] -p <text> --output-format stream-json [--model id] [--effort level] [--permission-mode mode]`
 *
 * The CLI accepts options after `-p`, and keeps `--resume` in front of the prompt.
 */
export function buildTurnArgs(input: TurnArgsInput): string[] {
  const args: string[] = [];

  if (input.sessionId) args.push("--resume", input.sessionId);

  args.push("-p", input.text, "--output-format", "stream-json");
  if (input.cwd) args.push("-C", input.cwd);
  if (input.model) args.push("--model", input.model);
  if (input.thinkingOption) args.push("--effort", input.thinkingOption);
  if (input.mode) args.push("--permission-mode", input.mode);

  return args;
}
