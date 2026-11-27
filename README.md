# doubao-cli-paseo-provider

A [Paseo](https://paseo.sh) provider plugin for the official [Doubao CLI](https://www.npmjs.com/package/@bytedance/doubao-cli) (`doubao`).

It plugs Doubao into Paseo's agent list with streaming text, native session resume, and a model
catalogue discovered from the CLI itself.

## Why a direct provider instead of ACP

`doubao` ships an ACP mode, but the interesting protocol for headless use is its `--output-format
stream-json` stream: it carries the answer deltas, the final message, the native session id and the
terminal result in one place. This plugin speaks that protocol directly, which keeps turns cheap
(one process per turn, no ACP handshake, no capability probing loop) and makes session resume exact.

## Features

- **Streaming turns** — `stream_event` deltas are coalesced into one growing assistant message.
- **Native resume** — the `session_id` from the `system` event is persisted and replayed through
  `--resume` on the next turn.
- **Dynamic catalogue** — models, per-model effort levels and default effort come from
  `doubao model list --output-format json`. No hard-coded model names, no locale-dependent parsing.
- **Session discovery** — `doubao --list --output-format json` is exposed as Paseo's session list.
- **Bounded discovery** — every probe has a timeout, so a broken CLI cannot hang the provider
  catalogue.
- **No global queue** — a long turn never blocks catalogue reads, configuration changes other
  sessions.

## Resource guards

The daemon should survive a runaway agent. Every limit below is enforced in the provider:

| Limit | Default | Behaviour when hit |
| --- | --- | --- |
| `maxConcurrentTurns` | 2 | extra prompt fails with `TOO_MANY_TURNS` instead of spawning another ~150 MB process |
| `maxTurnMs` | 30 min | the turn is stopped and fails with `TURN_TIMEOUT` |
| `stallTimeoutMs` | 5 min | a turn that produced no output is stopped with `TURN_STALLED` |
| `maxAssistantBytes` | 4 MiB | assistant text is cut at a UTF-8 boundary and marked `[output truncated]` |
| `maxStderrBytes` | 64 KiB | error detail is cut and marked `[truncated]` |
| `maxPromptBytes` | 1 MiB | the prompt is rejected with `PROMPT_TOO_LARGE` before spawning |
| `minFreeDiskBytes` | 512 MiB | the turn is refused with `DISK_LOW` instead of filling the disk |

Every limit can be tuned without rebuilding:

| Environment variable | Limit |
| --- | --- |
| `DOUBAO_PASEO_MAX_TURNS` | `maxConcurrentTurns` |
| `DOUBAO_PASEO_MAX_TURN_MS` | `maxTurnMs` |
| `DOUBAO_PASEO_STALL_MS` | `stallTimeoutMs` |
| `DOUBAO_PASEO_MAX_TEXT_BYTES` | `maxAssistantBytes` |
| `DOUBAO_PASEO_MAX_STDERR_BYTES` | `maxStderrBytes` |
| `DOUBAO_PASEO_MAX_PROMPT_BYTES` | `maxPromptBytes` |
| `DOUBAO_PASEO_MIN_FREE_DISK_MB` | `minFreeDiskBytes` |

Also:

- every discovery command (`model list`, `--list`, `auth status`) has a timeout;
- every spawned CLI is tracked and receives `SIGKILL` when the daemon exits, so a restart
  does not leave processes or their temp files behind;
- interrupt uses `SIGINT`, then `SIGKILL` after a grace period.

Defaults are deliberately conservative. To tune them in code:

```ts
createDoubaoProvider({ limits: { maxConcurrentTurns: 1, maxTurnMs: 10 * 60_000 } });
```

## Security

The plugin does not sandbox Doubao. In headless `-p` mode the CLI auto-approves tool calls
regardless of `--permission-mode`: both `ask_risky` and `ask_always` were observed writing files
without prompting (doubao 2.38.4, no TTY). The mode is forwarded for compatibility; Paseo does not
enforce an approval gate.

If you need isolation, run the daemon or the workspace in a container, a sandbox, or under a
dedicated user. Do not point this provider at a directory where unattended writes are unacceptable.

## Requirements

| Requirement | Version |
| --- | --- |
| Paseo | >= 0.15.0 |
| Node | >= 22 |
| Doubao CLI | installed and logged in (`doubao auth status` must exit 0) |

## Install

```bash
git clone https://github.com/Angboo/doubao-cli-paseo-provider.git
cd doubao-cli-paseo-provider
npm install
paseo plugin install .
```

Verify:

```bash
paseo plugin ls
paseo run --provider doubao "Reply with exactly: PONG"
```

## Usage

```bash
# one shot
paseo run --provider doubao "Explain the architecture of this repository"

# pick a model and a reasoning level
paseo run --provider doubao --model person-deepseek-v4-1-flash-261017 --thinking max "Refactor the data layer"

# continue an agent
paseo send <agent-id> "Add tests for the change"
```

Model ids and effort levels are whatever the CLI reports for your account.

## Configuration

The plugin registers the provider id `doubao`. Defaults, model allow-lists and environment
overrides use Paseo's normal provider configuration:

```json
{
  "agents": {
    "providers": {
      "doubao": {
        "enabled": true,
        "options": {}
      }
    }
  }
}
```

## Development

See [docs/TESTING.md](docs/TESTING.md) for the full test matrix, environment variables and
troubleshooting.

```bash
npm install
npm run typecheck
npm test          # unit tests, no CLI needed
npm run test:live # unit tests + real CLI (sends one tiny prompt)
npm run e2e       # throwaway Paseo daemon on a free port, installs the plugin,
                  # runs a turn and a follow-up that proves resume worked
npm run e2e:draw  # full drawing flow: generate an image, describe it without
                  # regenerating, then repaint a night version
npm run soak      # 20 real turns: RSS growth, leaked processes, restart resume
```

Test layout:

| Suite | Covers |
| --- | --- |
| `stream.test.ts` | NDJSON framing, split UTF-8, duplicate session ids, delta accumulation, assistant/result events, error results |
| `catalog.test.ts` | model-list mapping, malformed entries, cache TTL, single-flight probing |
| `sessions.test.ts` | session-list mapping, persisted native ids |
| `args.test.ts` | CLI argument order for fresh and resumed turns |
| `prompt.test.ts` | text, image, file, PR, issue, review formatting |
| `errors.test.ts` | stderr cleanup and error codes |
| `session.test.ts` | state machine against a fake CLI: resume, interrupts, failures, close during a turn |
| `provider.test.ts` | registration, capability negotiation, dispatch, cache keys |
| `cli.test.ts` | last-protocol-line extraction |
| `live.test.ts` | real `model list` and `--list` |
| `live-provider.test.ts` | full provider connection: open → prompt → completed → persistence |
| `scripts/e2e.sh` | isolated Paseo daemon on a free port: install, run, resume |
| `scripts/e2e-drawing.sh` | three-turn drawing flow: paint, describe, repaint; checks PNG magic, dimensions, size and that the second image differs |

## Limitations

- The timeline is text. Tool calls are not mapped to Paseo tool cards yet.
- Attachments are rendered as readable context blocks; the CLI is not given binary payloads.
- `--permission-mode` is forwarded, but headless `-p` runs cannot ask interactively. Use it to match
  your policy, not as a hard approval gate.
- Interrupt sends `SIGINT`, then `SIGKILL` after a grace period.

## License

MIT
