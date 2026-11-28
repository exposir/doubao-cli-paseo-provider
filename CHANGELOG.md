# Changelog

## Unreleased

### Added

- Self-owned Doubao-native ACP v1 driver (`DOUBAO_PASEO_TRANSPORT=acp` or
  `createDoubaoProvider({ transport: "acp" })`), zero extra runtime dependencies, compatible
  with both Paseo **0.15.0** and **0.17.6**:
  - Bidirectional NDJSON JSON-RPC 2.0 over stdio (`server/acp-protocol.ts`,
    `server/acp-runtime.ts`, `server/acp-session.ts`, `server/acp-timeline.ts`,
    `server/acp.ts`) with early `available_commands_update` buffering during `session/new`.
  - Interactive tool approvals (`session/request_permission`) with command/path descriptions,
    plus interactive question forms (`elicitation/create` ↔ Paseo `kind: "question"`).
  - Real multimodal image support (`prompt.image`) via session-private temporary files
    (`0700`/`0600`) inspected by Doubao's native Read tool and cleaned up on close/exit.
  - Native `fs/read_text_file` workspace callback with realpath confinement, line slicing,
    and cumulative 64 KiB `resource_link` budgeting.
  - Built-in command vs cloud skill classification (`init`, `review`, `compact`, `agent-new`
    vs cloud skills), first-turn `systemPrompt` injection, `session.launch_wrap`, paginated
    `session/list`, `request.cancel`, idle runtime reclamation (`DOUBAO_PASEO_IDLE_MS`) with
    transparent `session/load` hot reload, and graceful `session/cancel` escalation.
- Provider `docsUrl` and `installation.inspect` (`doubao --version`) across both transports.
- Tool calls are rendered as Paseo cards (`shell`, `read`, `write`, `edit`, `search`, `fetch`,
  `think`, `switch_mode`) with running/completed/failed states and sub-agent `thread_id` scoping.
- A dismissible warning at `stream-json` session start explains that headless Doubao cannot
  route interactive approvals through Paseo.
- Recursive `doubao -p/--resume` and `paseo run/send/...` tool calls are blocked at tool-call
  time; the card is marked canceled and the turn stops with a warning.
- `npm run scenarios`: eight end-to-end scenarios — quick answer, news search, file
  write, code reading, multi-turn recall, image generation, long multi-step task and a
  live concurrency probe.

### Fixed

- `stream-json` now passes prompts over stdin (`-p -`) instead of argv, avoiding Linux
  128 KiB `MAX_ARG_STRLEN` `E2BIG` failures and command-line leakage.
- `stream-json` now parses real Doubao CLI error payloads (`errors[]`, `error.code`,
  `permission_denials`, `log_id`), preserves persisted session IDs on `exit 4`
  (`login_required`), bounds NDJSON lines at 16 MiB (`STREAM_LINE_TOO_LARGE`), tracks text
  flushes with a monotonic version counter, splits multi-message replies by `message_id`,
  and preserves `ProviderTextAttachment` titles and `externalResource` headers.
- Removed prompt-mutating safety note injection and non-functional `-p` slash commands.
- Process-group teardown (`detached: true`, `-pid` kill) and live-owner orphan reaping work
  on both Linux (`/proc`) and macOS (`ps -axww -E`), and empty model-list probes are no longer
  pinned in the TTL cache.
- Turns killed by a signal now fail with `SIGNAL_<name>` and the stderr tail instead of
  the opaque `EXIT_null`.
- A signal, timeout or stall drops the persisted native session id, so the next turn
  starts a clean Doubao session instead of resuming a locked one.
- The concurrency cap is global across all connections and both transports.
- `npm test` cleans `dist` first, so deleted tests cannot run from stale build output.
- A non-zero CLI exit (other than `login_required`) also drops the native session id.
- Prompts are checked against the CLI's 262,144 code point limit, not only the byte cap.
- Tool output is capped at 64 KiB per card so a huge command cannot bloat the daemon.

## 0.1.0 — 2026-11-27

First release.

### Provider

- Direct provider on `doubao --output-format stream-json`; one process per turn, no ACP.
- Streaming assistant text, coalesced into at most a few timeline updates per turn.
- Native session id persistence and `--resume` for follow-up turns.
- Model catalogue from `doubao model list --output-format json`, including per-model
  effort levels and defaults.
- Session discovery through `doubao --list --output-format json`.

### Resource guards

- Per-connection concurrency cap (default 2), per-turn deadline (30 min) and stall
  watchdog (5 min).
- Byte caps for assistant text, stderr and prompts, truncated on UTF-8 boundaries.
- Free-disk floor before starting a turn.
- Tracked children are `SIGKILL`ed on daemon exit; a marker-based sweep on startup
  cleans up after a daemon that was killed hard.
- Limit overrides through `DOUBAO_PASEO_*` environment variables.

### Quality

- 140 tests: unit coverage for parsing, catalogue, sessions, provider dispatch,
  guards, performance and orphan reaping, plus live CLI tests.
- Throwaway-daemon E2E for a basic two-turn flow and a three-turn drawing flow.
- 20-turn soak with RSS and orphan checks and a restart-resume assertion.
- Typechecked against Paseo plugin SDK 0.15.0 and 0.17.6.

### Known limitations

- Text-only timeline; tool calls are not rendered as Paseo cards.
- Headless permission modes are advisory; the CLI auto-approves.
