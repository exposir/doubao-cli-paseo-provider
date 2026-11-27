# Changelog

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
