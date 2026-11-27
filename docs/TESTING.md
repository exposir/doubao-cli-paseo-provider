# Testing

Four layers, cheapest first. Each layer is independently runnable.

| Layer | Command | Needs CLI | Needs login | Model calls |
| --- | --- | --- | --- | --- |
| Unit | `npm test` | no | no | 0 |
| Live CLI | `npm run test:live` | yes | yes | 0 (discovery only) |
| Daemon E2E | `npm run e2e` | yes | yes | 2 text turns |
| Drawing E2E | `npm run e2e:draw` | yes | yes | 2 image turns + 1 text turn |

## Unit

`npm test` compiles with `tsc` and runs `node --test` over `dist/test/`.

| File | Covers |
| --- | --- |
| `stream.test.ts` | NDJSON framing across chunk boundaries, CRLF, a multi-byte character split across buffers, delta accumulation, assistant/result precedence, duplicate session ids, non-text deltas, error results, subtype-only errors, array content, unknown events |
| `catalog.test.ts` | model-list mapping, per-model effort levels, duplicate ids, malformed entries, cache keys, TTL/force, single-flight probing, failure fallback |
| `sessions.test.ts` | `--list` payload mapping, malformed rows, persisted native session ids |
| `args.test.ts` | CLI argument order for fresh and resumed turns |
| `prompt.test.ts` | text, image, uploaded file, GitHub and forge PR/issue formatting, review comments, unknown attachment types |
| `errors.test.ts` | stderr cleanup, truncation boundaries, error codes |
| `session.test.ts` | session state machine against a fake CLI: happy path, resume args, restored persistence id, non-zero exit, result errors, empty prompt, concurrent prompt, interrupt and reuse, close during a turn, idempotent close, open/configure events, configure(null) reset, prompt size cap, timeout, stall watchdog, output caps, burst coalescing, argv safety against shell metacharacters |
| `provider.test.ts` | registration, version/launch validation, capability negotiation, catalogue and session-list dispatch, unknown sessions (prompt/configure/close), unnegotiated requests, idempotent close, cache keys, concurrency cap and slot release, catalogue failure fallback, session-list limit clamping |
| `cli.test.ts` | last-protocol-line extraction over logs, noise and malformed tails |
| `limits.test.ts` | limit merging, invalid-value fallback, UTF-8-safe truncation, byte-bounded buffers |
| `performance.test.ts` | 20k delta reduction stays linear, and the byte cap does not rescan the answer |

No network, no CLI, safe for CI.

## Performance

The guards sit on the hot path, so each check is O(chunk), never O(answer):

- byte length is tracked incrementally; the cap check never re-scans accumulated text;
- timeline updates are coalesced: 80 ms tick, 256-byte growth floor, 500 ms idle ceiling;
- the stall watchdog uses `timer.refresh()` instead of allocating a timer per chunk;
- stderr is byte-bounded as it is appended;
- comparing the accumulated answer (O(n)) was removed from the per-token path in favour of
  comparing byte counters.

`test/performance.test.ts` reduces 20,000 deltas (320 KB) in ~30 ms on the development host, and
the capped variant in ~15 ms. A 2,000-delta burst produces fewer than 32 timeline updates.

## Live CLI

`npm run test:live` adds the tests gated by `DOUBAO_LIVE=1`:

- `live.test.ts` — real `doubao model list --output-format json` and `doubao --list --output-format json`
- `live-provider.test.ts` — opens a provider connection in-process, sends one prompt, waits for `session.turn: completed`, asserts the assistant text and that `session.persistence` fired

These need a logged-in CLI (`doubao auth status` exits 0). They cost one tiny model call.

## Daemon E2E

`scripts/e2e.sh` starts a **throwaway Paseo daemon** on a free port with its own home, installs the plugin from the repo, and drives it through the real CLI:

1. daemon start and plugin reaches `running`
2. `doubao` provider registers
3. one agent turn produces the expected answer
4. a follow-up proves the native session was resumed

The temporary home is removed on exit. Its config is the minimum Paseo needs:

```json
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:<free port>",
    "relay": { "enabled": false }
  },
  "pluginsEnabled": true,
  "agents": { "providers": {} },
  "features": {}
}
```

Two details that are easy to miss:

- `pluginsEnabled` must be `true`, or the plugin installs but stays `disabled`.
- `paseo-plugin.json` `icon` must point at a **PNG**; Paseo rejects an SVG path.

## Drawing E2E

`scripts/e2e-drawing.sh` is the long flow:

1. starts the isolated daemon and installs the plugin
2. **paint** — asks for an image saved to an absolute path, then asserts:
   - file exists
   - PNG magic bytes
   - width ≥ 512
   - size ≥ 100 KB
3. **describe** — asks the agent to describe the image *without repainting*; the answer must mention the cat and the warm/sunset palette, which proves `--resume` kept the context
4. **repaint** — asks for a night version; asserts the second file is a valid PNG and has a different SHA-256 from the first
5. asserts all three prompts are present in the timeline

Artifacts are copied to `/tmp/doubao-drawing-artifacts` before cleanup.

## Soak

`scripts/soak.sh` runs `PASEO_SOAK_TURNS` real turns on a throwaway daemon, then:

- samples the daemon worker RSS at every turn and fails above `PASEO_SOAK_MAX_RSS_GROWTH_MB`;
- scans `/proc` for the provider's child marker after each turn and fails if any Doubao
  process survived;
- restarts the daemon and asks the agent for the previous token, which only works if
  `--resume` kept the native session.

Run it before a release and after any change to process handling or guards.

## General scenarios

`scripts/scenarios.sh` runs eight end-to-end scenarios on a throwaway daemon, each with an
explicit assertion:

| Scenario | Assertion |
| --- | --- |
| quick answer | the reply contains `PONG` |
| news search | a non-trivial answer with a source or link |
| file write | `hello.txt` exists with the requested content |
| code reading | the answer references the function's purpose |
| multi-turn | the secret from turn one is recalled in turn two |
| image | a valid PNG of at least 512×512 |
| concurrency cap | a second turn is rejected while the long task runs |
| long task | four files exist, `DONE` is reported, daemon RSS growth ≤ 150 MB |

The long task is capped at ten minutes. The suite costs seven model calls plus one image.

## Interrupt check

`scripts/interrupt-check.sh` starts a real image turn, stops the agent after eight
seconds, then asserts that zero Doubao processes carry the provider marker and that the
agent is back to `idle`. Costs one partial image generation.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PASEO_E2E_KEEP` | `0` | `1` keeps the temporary home (daemon logs, workspace) |
| `PASEO_DRAW_ARTIFACTS` | `/tmp/doubao-drawing-artifacts` | where the two PNGs are copied |
| `PASEO_E2E_EXPECT` | `E2E-OK` | expected string in the basic e2e |
| `PASEO_SOAK_TURNS` | `20` | turns in the soak script |
| `PASEO_SOAK_MAX_RSS_GROWTH_MB` | `150` | fail the soak above this daemon RSS growth |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `plugin ls` shows `disabled` | plugins are globally off | set `pluginsEnabled: true` in the home config and restart the daemon |
| `Expected a relative path to a PNG` | manifest points at an SVG | point `icon` at a PNG (`node scripts/make-icon.mjs` regenerates one) |
| `Unrecognized key: "listen"` | wrong config nesting | the key is `daemon.listen`, not a top-level `listen` |
| Follow-up loses context | native session id was not persisted | check the turn emitted `session.persistence`; run `npm run test:live` |
| `paseo run` says `Workspace not found` | the daemon knows a stale workspace id | use `--new-workspace local` in a fresh project directory |
| e2e times out | image turns can take ~60s each | raise the `timeout` around `paseo run` / `paseo send` |

## Cost and time

Unit tests run in about a second. The live provider test takes ~5–10s and one short completion. The drawing flow takes roughly 1.5–3 minutes because it generates two images.
