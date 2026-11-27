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
