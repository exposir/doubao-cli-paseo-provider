#!/usr/bin/env bash
#
# Soak: many real turns on a throwaway daemon, watching for daemon RSS growth
# and leaked Doubao processes, then a daemon restart followed by a turn that
# proves the native session survives.
#
#   PASEO_SOAK_TURNS=20 bash scripts/soak.sh
#
# Costs TURNS + 1 small model calls.
#
set -euo pipefail

TURNS="${PASEO_SOAK_TURNS:-20}"
MAX_RSS_GROWTH_MB="${PASEO_SOAK_MAX_RSS_GROWTH_MB:-150}"
TRANSPORT="${DOUBAO_PASEO_TRANSPORT:-stream-json}"
export DOUBAO_PASEO_TRANSPORT="$TRANSPORT"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paseo-soak.XXXXXX")"
WORK_DIR="${HOME_DIR}/workspace"
PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

MARKER="paseo-$(printf '%s' "$HOME_DIR" | sha256_hex | cut -c1-12)"

now_ms() {
  python3 -c 'import time; print(time.time_ns() // 1_000_000)'
}

with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

try:
    result = subprocess.run(sys.argv[2:], timeout=float(sys.argv[1]))
except subprocess.TimeoutExpired:
    raise SystemExit(124)
raise SystemExit(result.returncode)
PY
  fi
}

cleanup() {
  paseo --home "$HOME_DIR" daemon stop >/dev/null 2>&1 || true
  if [ "${PASEO_E2E_KEEP:-0}" = "1" ]; then
    echo "保留: ${HOME_DIR}"
  else
    rm -rf "$HOME_DIR"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  [ -f "${HOME_DIR}/daemon.log" ] && tail -n 20 "${HOME_DIR}/daemon.log" >&2
  exit 1
}

count_marked() {
  if [ ! -d /proc/1 ]; then
    local matches
    matches="$(ps -axww -E -o pid=,command= 2>/dev/null |
      grep -Ec "(^|[[:space:]])PASEO_DOUBAO_CHILD=${MARKER}([[:space:]]|$)" || true)"
    echo "${matches:-0}"
    return
  fi
  local count=0
  for proc in /proc/[0-9]*; do
    [ -r "${proc}/environ" ] || continue
    if tr '\0' '\n' < "${proc}/environ" 2>/dev/null | grep -qx "PASEO_DOUBAO_CHILD=${MARKER}"; then
      count=$((count + 1))
    fi
  done
  echo "${count}"
}

rss_mb() {
  local rss_kb
  rss_kb="$(ps -o rss= -p "$1" 2>/dev/null | tr -d ' ')"
  [ -n "$rss_kb" ] || { echo 0; return; }
  awk -v rss="$rss_kb" 'BEGIN {print int(rss / 1024)}'
}

worker_pid() {
  paseo --home "$HOME_DIR" daemon status --json 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("workerPid", ""))
except Exception:
    print("")
'
}

mkdir -p "$WORK_DIR"
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" config user.name soak
git -C "$WORK_DIR" config user.email soak@local
git -C "$WORK_DIR" commit -q --allow-empty -m init

cat > "$HOME_DIR/config.json" <<JSON
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:${PORT}",
    "relay": { "enabled": false }
  },
  "pluginsEnabled": true,
  "agents": { "providers": {} },
  "features": {}
}
JSON

echo "==> daemon on 127.0.0.1:${PORT}, ${TURNS} turns, transport ${TRANSPORT}"
paseo --home "$HOME_DIR" daemon start >/dev/null
paseo --home "$HOME_DIR" plugin install "$REPO_DIR" >/dev/null 2>&1
paseo --home "$HOME_DIR" project create "$WORK_DIR" >/dev/null

echo "==> first turn"
RUN="$(cd "$WORK_DIR" && paseo --home "$HOME_DIR" run --provider doubao --new-workspace local "只回复 TOKEN-0")"
AGENT_ID="$(printf '%s\n' "$RUN" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[ -n "$AGENT_ID" ] || fail "no agent id"

PID=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  PID="$(worker_pid)"
  [ -n "$PID" ] && break
  sleep 1
done
[ -n "$PID" ] || fail "no worker pid"
RSS_START="$(rss_mb "$PID")"
RSS_MAX="$RSS_START"

printf 'turn  rss(MB)  marked  ms\n'
for index in $(seq 1 "$TURNS"); do
  started="$(now_ms)"
  with_timeout 180 paseo --home "$HOME_DIR" send "$AGENT_ID" "只回复 TOKEN-${index}" >/dev/null \
    || fail "turn ${index} did not complete"
  elapsed=$(( $(now_ms) - started ))

  sleep 1
  orphans="$(count_marked)"
  if [ "$TRANSPORT" != "acp" ]; then
    [ "$orphans" -eq 0 ] || fail "turn ${index} left ${orphans} doubao process(es) behind"
  fi

  rss="$(rss_mb "$PID")"
  if [ "$rss" -gt "$RSS_MAX" ]; then RSS_MAX="$rss"; fi
  printf '%4d  %7d  %6d  %5d\n' "$index" "$rss" "$orphans" "$elapsed"

  printf '%s\n' "$(paseo --home "$HOME_DIR" logs "$AGENT_ID" | tail -n 2)" | grep -q "TOKEN-${index}" \
    || fail "turn ${index} answer missing"
done

GROWTH=$((RSS_MAX - RSS_START))
echo "==> daemon RSS: start ${RSS_START} MB, peak ${RSS_MAX} MB, growth ${GROWTH} MB"
[ "$GROWTH" -le "$MAX_RSS_GROWTH_MB" ] || fail "RSS grew ${GROWTH} MB, limit ${MAX_RSS_GROWTH_MB} MB"

echo "==> restart daemon, then a follow-up that proves resume"
paseo --home "$HOME_DIR" daemon stop >/dev/null
paseo --home "$HOME_DIR" daemon start >/dev/null

with_timeout 180 paseo --home "$HOME_DIR" send "$AGENT_ID" \
  "不要执行新任务。只回答：上一轮我让你回复的 token 是什么？" >/dev/null \
  || fail "post-restart turn did not complete"

LOGS="$(paseo --home "$HOME_DIR" logs "$AGENT_ID")"
printf '%s' "$LOGS" | grep -q "TOKEN-${TURNS}" || fail "session did not resume after restart"

sleep 1
paseo --home "$HOME_DIR" daemon stop >/dev/null
orphans="$(count_marked)"
[ "$orphans" -eq 0 ] || fail "${orphans} doubao process(es) left after daemon stop"

echo
echo "PASS: ${TURNS} turns, RSS growth ${GROWTH} MB, no leaked processes, resume after restart"
