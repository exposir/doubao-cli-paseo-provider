# Production notes

Operational checklist for running the Doubao provider on a shared host.

## Compatibility

| Component | Verified |
| --- | --- |
| Paseo plugin SDK | 0.15.0 and 0.17.6 for both transports |
| Paseo daemon | 0.17.6 for the published `stream-json` E2E and soak results |
| Doubao CLI | 2.38.4; `stream-json` or ACP v1 over stdio |

The daemon defaults to `stream-json`. Set `DOUBAO_PASEO_TRANSPORT=acp` to enable the native
driver, which uses the provider interfaces available in Paseo 0.15.0. Paseo hosts that offer
`session.launch_wrap` can wrap the ACP subprocess. Both transports check login with a
five-second `doubao auth status` probe.

## Capacity

| Item | Value |
| --- | --- |
| One Doubao turn process | ~150 MB RSS (plus short-lived helpers) |
| Default concurrent turns | 2 across all connections and both transports, about 300 MB for their CLI processes |
| Inactive ACP process | Reclaimed after five minutes by default |
| Assistant text kept per turn | 4 MiB, shared by assistant replies and reasoning in ACP |
| Worst-case stderr kept | 64 KiB |

On a 1.6 GB host, keep `DOUBAO_PASEO_MAX_TURNS=1` if the Paseo daemon and other
agents already use more than 600 MB. When using ACP, also budget for recently used
and newly opened sessions during their idle window. The turn cap counts active turns.

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
| `idleRuntimeMs` (ACP only) | 5 min | `DOUBAO_PASEO_IDLE_MS` |
| `maxAssistantBytes` | 4 MiB | `DOUBAO_PASEO_MAX_TEXT_BYTES` |
| `maxStderrBytes` | 64 KiB | `DOUBAO_PASEO_MAX_STDERR_BYTES` |
| `maxPromptBytes` | 1 MiB | `DOUBAO_PASEO_MAX_PROMPT_BYTES` |
| `minFreeDiskBytes` | 512 MiB | `DOUBAO_PASEO_MIN_FREE_DISK_MB` |

Negative and non-finite overrides fall back to the default. A zero duration disables the
corresponding watchdog. Zero turn, assistant, prompt-byte, or disk limits disable those caps.
Zero stderr bytes disable collection. The CLI prompt ceiling of 262,144 Unicode code points
still applies, and tool output is capped at 64 KiB per card.

## ACP lifecycle

- Catalogue discovery shares the five-minute `doubao model list` cache. `session/list`
  uses a separate, time-bounded subprocess and returns IDs accepted by `session/load`.
- Commands that arrive during `session/new` are delivered before the session is ready.
  Initial history replay is opt-in via Paseo's `history: "replay"`.
- A pending approval pauses the stall watchdog. The hard turn deadline continues to run.
  Interrupt, timeout, stall and close cancel pending approval requests and send `session/cancel`.
  After a 2.5-second grace period, an unresponsive turn is stopped with a process-group kill.
- The negotiated `prompt.image` capability decodes and stores image inputs one file at a time
  under a session-private `0700` directory with `0600` files. The prompt references absolute
  paths for Doubao's native Read tool and removes the directory when the session closes.
  Invalid or oversized images use a text fallback.
- `elicitation/create` questions share the approval lifecycle, including a paused stall timer,
  cancellation and `canStopRuntime = false` while an answer is pending. The requested
  `fs/read_text_file` callback serves only real regular files inside the workspace and limits
  each response to 64 KiB.
- Uploaded workspace text files become ACP `resource_link` blocks while a cumulative 64 KiB
  prompt budget remains. Binary, unreadable, oversized and out-of-workspace files fall back to
  text summaries.
- Built-in and cloud command entries are classified separately. A new unbound session can carry
  `systemPrompt` once on its first plain message without changing slash-command behavior or
  resumed sessions. Provider registration also exposes install/docs URLs and version inspection.
- Idle reclamation closes the CLI subprocess while keeping the selected model, reasoning
  level, and mode. The next prompt or config change reloads a bound session without replay.
  Doubao only persists a new session after its first completed turn, so a zero-turn session
  is recreated on reconnect.
- `login_required` and `busy` preserve the saved session ID. `not_found` clears it and
  falls back to a new session with a warning when loading. A forced stop of an active turn
  clears the saved ID because a cloud turn may still hold the old session lock.

## Security

- The plugin runs with daemon-level trust and does not sandbox the CLI.
- In headless `-p` mode, Paseo cannot gate tool approvals: workspace writes execute without
  confirmation (`ask_risky` and `ask_always` both wrote files without a prompt in testing),
  while server-side approval requests are automatically denied by the CLI (`permission_denials`).
  Treat every turn as unattended workspace write access.
- Run the daemon in a container or under a dedicated user when the workspace contains
  anything you would not let an unattended agent modify.
- Spawned CLI runtimes run in their own POSIX process group and carry a per-home marker
  (`PASEO_DOUBAO_CHILD`). On startup the plugin sweeps for that marker (via `/proc` on Linux
  or `ps -E` on macOS) and reaps orphaned processes. The owner's PID
  (`PASEO_DOUBAO_OWNER`) keeps the sweep from signaling children managed by a live provider.

## Observability

Guard events that are written to the daemon log use a `[doubao-provider]` prefix.
Failed `stream-json` turns include `result.log_id` in Paseo and the daemon log when the
CLI supplied it. ACP crash and startup failures include buffered CLI stderr.

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
| `PROMPT_TOO_LARGE` | prompt above the byte or code-point limit |
| `EXIT_n` | CLI exited non-zero |
| `SPAWN_ERROR` | CLI could not be started |
| `DOUBAO_RESULT_ERROR` | `result` event reported an error |
| `DOUBAO_LOGIN_REQUIRED` | Doubao authentication needs attention |
| `DOUBAO_SESSION_BUSY` | another turn or configuration change is active |
| `DOUBAO_SESSION_NOT_FOUND` | the cloud session no longer exists |
| `DOUBAO_INVALID_ARGUMENTS` | Doubao rejected the ACP request parameters |
| `DOUBAO_INTERNAL_ERROR` | Doubao reported an internal ACP error |
| `ACP_REQUEST_TIMEOUT` | startup, configuration, or listing exceeded the RPC deadline |
| `ACP_RUNTIME_EXIT` | the CLI exited unexpectedly |
| `UNKNOWN_SESSION` | request for a session that is not open |
| `SESSION_EXISTS` | duplicate `session.open` |

## Verification

```bash
npm run typecheck       # default SDK 0.17.6
npm test                # 233 unit tests, including 55 ACP tests
npm run test:live       # + 4 live tests
npm run e2e             # throwaway daemon, 2 turns
npm run e2e:draw        # 3-turn drawing flow
npm run soak            # 20 real turns, RSS and orphan checks, restart resume
npm run scenarios       # everyday tasks, image, long task, concurrency cap
```

The `stream-json` soak script samples the daemon worker's RSS at every turn, fails if any Doubao
process survives a turn, and after a daemon restart asks the agent for the previous
token to prove the native session was resumed.

Measured on 2026-11-27 (1.6 GB host, doubao 2.38.4): 20 turns, 8–9 s per turn, daemon
RSS 166 MB peak with no growth across the run, zero leaked processes after every turn,
and the restart follow-up returned the previous token.

Real interrupt (same host): during an image turn two Doubao processes were running;
`paseo stop` left zero within two seconds and the agent returned to `idle`
(`scripts/interrupt-check.sh`).

Scenario suite (same host): quick answer 13 s, news search 25 s, file write 32 s, code
reading 18 s, multi-turn recall 32 s, image 66 s, long four-file task 24 s with 0 MB RSS
growth, and the concurrency probe was rejected while the long task was running.

## Upgrade and rollback

The plugin has no persisted config of its own; provider state lives in Paseo's agent
files. To upgrade, replace the directory (or git ref) and run `paseo plugin reload
doubao-cli-paseo`. To roll back, reinstall the previous tag and reload. Existing agents
keep their Doubao session ids as long as the CLI still accepts them.

## Known limitations

- Tool calls render as Paseo cards; results are text, and structured diffs appear only when the
  CLI returns one.
- A single model request that grows too large can be killed by the CLI service around 90–100 s.
  Split big analyses into smaller prompts.
- `stream-json` headless approval modes are advisory. ACP carries the CLI's interactive
  permission requests (see Security).
- The catalogue is cached for 5 minutes; account model changes can lag.
- Interrupt sends `SIGINT`, then `SIGKILL` after 3 seconds.
