export interface TurnArgsInput {
  /** Native session to continue, when the provider already learned one. */
  sessionId?: string | null;
  cwd?: string;
  /** Catalogue model id (not the display name). */
  model?: string;
  thinkingOption?: string;
  mode?: string;
}

/**
 * `doubao [--resume id] -p - --output-format stream-json [-C dir] [--model id] [--effort level] [--permission-mode mode]`
 *
 * Passing `-p -` reads the prompt from stdin (up to the CLI's 1 MiB / 262,144 code point
 * limits), avoiding OS argv caps (128 KiB per argument on Linux) and keeping prompts out of ps.
 */
export function buildTurnArgs(input: TurnArgsInput): string[] {
  const args: string[] = [];

  if (input.sessionId) args.push("--resume", input.sessionId);

  args.push("-p", "-", "--output-format", "stream-json");
  if (input.cwd) args.push("-C", input.cwd);
  if (input.model) args.push("--model", input.model);
  if (input.thinkingOption) args.push("--effort", input.thinkingOption);
  if (input.mode) args.push("--permission-mode", input.mode);

  return args;
}
