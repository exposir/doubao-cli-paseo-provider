# Production notes

Operational checklist for running the Doubao provider on a shared host.

## Compatibility

| Component | Verified |
| --- | --- |
| Paseo plugin SDK | 0.15.0 and 0.17.6 (typecheck against both) |
| Paseo daemon | 0.17.6 (daemon E2E and soak) |
| Doubao CLI | 2.38.4, logged in, `stream-json` output |

`stream-json` is required; the plugin does not use ACP. A CLI version that drops
`--output-format stream-json` will fail at the first turn with a spawn or result error.

## Capacity

| Item | Value |
| --- | --- |
| One Doubao turn process | ~150 MB RSS (plus short-lived helpers) |
| Default concurrent turns | 2, so ~300 MB peak |
| Assistant text kept per turn | 4 MiB cap |
| Worst-case stderr kept | 64 KiB |

On a 1.6 GB host, keep `DOUBAO_PASEO_MAX_TURNS=1` if the Paseo daemon and other
agents already use more than 600 MB.

Disk is not fully under the plugin's control: files the agent creates (images,
generated projects) are written by the CLI. The provider refuses to start a turn
when free space is below `minFreeDiskBytes` (default 512 MiB), but you still need
external cleanup or quotas for long-lived workspaces.

## Limits

| Limit | Default | Environment variable |
| --- | --- | --- |
| `maxConcurrentTurns` | 2 | `DOUBAO_PASEO_MAX_TURNS` |
| `maxTurnMs` | 30 min | `DOUBAO_PASEO_MAX_TURN_MS` |
| `stallTimeoutMs` | 5 min | `DOUBAO_PASEO_STALL_MS` |
| `maxAssistantBytes` | 4 MiB | `DOUBAO_PASEO_MAX_TEXT_BYTES` |
| `maxStderrBytes` | 64 KiB | `DOUBAO_PASEO_MAX_STDERR_BYTES` |
| `maxPromptBytes` | 1 MiB | `DOUBAO_PASEO_MAX_PROMPT_BYTES` |
| `minFreeDiskBytes` | 512 MiB | `DOUBAO_PASEO_MIN_FREE_DISK_MB` |

Values that are negative, NaN or infinite fall back to the default. Setting a limit
to `0` disables that guard.

## Security

- The plugin runs with daemon-level trust and does not sandbox the CLI.
- In headless `-p` mode, Doubao auto-approves tool calls regardless of
  `--permission-mode`. `ask_risky` and `ask_always` both wrote files without a prompt
  in testing. Treat every turn as unattended write access.
- Run the daemon in a container or under a dedicated user when the workspace contains
  anything you would not let an unattended agent modify.
- Spawned turns carry a per-home marker (`PASEO_DOUBAO_CHILD`). On startup the plugin
  sweeps `/proc` for that marker, so children left by a `SIGKILL`ed daemon are cleaned
  up on the next start. Manual `doubao` sessions are untouched.
- A `doubao` shim on the turn's `PATH` blocks nested `-p` / `--resume` calls (exit 64)
  so an agent cannot attach to its own conversation and deadlock. Set
  `DOUBAO_PASEO_ALLOW_NESTED=1` to opt out.

## Observability

Guard events go to the daemon log with a `[doubao-provider]` prefix:

```
[doubao-provider] assistant output truncated at 4194304 bytes (session ...)
[doubao-provider] turn ... exceeded 1800000 ms and was stopped (session ...)
[doubao-provider] turn ... produced no output for 300000 ms (session ...)
[doubao-provider] refusing turn: 2 running, limit 2
[doubao-provider] refusing turn in /path: 120 MB free, 512 MB required
[doubao-provider] reaped N stale child process(es) from a previous daemon
```

Failure codes surfaced to Paseo:

| Code | Meaning |
| --- | --- |
| `TURN_TIMEOUT` | exceeded `maxTurnMs` |
| `TURN_STALLED` | no output within `stallTimeoutMs` |
| `TOO_MANY_TURNS` | concurrency cap reached |
| `DISK_LOW` | workspace filesystem below the floor |
| `PROMPT_TOO_LARGE` | prompt above `maxPromptBytes` |
| `EXIT_n` | CLI exited non-zero |
| `SPAWN_ERROR` | CLI could not be started |
| `DOUBAO_RESULT_ERROR` | `result` event reported an error |
| `UNKNOWN_SESSION` | request for a session that is not open |
| `SESSION_EXISTS` | duplicate `session.open` |

## Verification

```bash
npm run typecheck       # 0.17.6 types
npm test                # 137 unit tests
npm run test:live       # + 3 live tests
npm run e2e             # throwaway daemon, 2 turns
npm run e2e:draw        # 3-turn drawing flow
npm run soak            # 20 real turns, RSS and orphan checks, restart resume
```

The soak script samples the daemon worker's RSS at every turn, fails if any Doubao
process survives a turn, and after a daemon restart asks the agent for the previous
token to prove the native session was resumed.

Measured on 2026-11-27 (1.6 GB host, doubao 2.38.4): 20 turns, 8–9 s per turn, daemon
RSS 166 MB peak with no growth across the run, zero leaked processes after every turn,
and the restart follow-up returned the previous token.

Real interrupt (same host): during an image turn two Doubao processes were running;
`paseo stop` left zero within two seconds and the agent returned to `idle`
(`scripts/interrupt-check.sh`).

## Upgrade and rollback

The plugin has no persisted config of its own; provider state lives in Paseo's agent
files. To upgrade, replace the directory (or git ref) and run `paseo plugin reload
doubao-cli-paseo`. To roll back, reinstall the previous tag and reload. Existing agents
keep their Doubao session ids as long as the CLI still accepts them.

## Known limitations

- The timeline is text only; tool calls and diffs are not mapped to Paseo cards.
- Headless approval modes are advisory (see Security).
- The catalogue is cached for 5 minutes; account model changes can lag.
- Interrupt sends `SIGINT`, then `SIGKILL` after 3 seconds.
