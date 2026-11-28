#!/usr/bin/env bash
#
# Real interrupt check: start an image turn, stop it mid-flight, then assert
# that no Doubao process survives and the agent returns to idle.
#
#   bash scripts/interrupt-check.sh
#
# Costs one partial image generation.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paseo-int.XXXXXX")"
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

mkdir -p "$WORK_DIR"
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" config user.name interrupt
git -C "$WORK_DIR" config user.email interrupt@local
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

echo "==> daemon on 127.0.0.1:${PORT}"
paseo --home "$HOME_DIR" daemon start >/dev/null
paseo --home "$HOME_DIR" plugin install "$REPO_DIR" >/dev/null 2>&1
paseo --home "$HOME_DIR" project create "$WORK_DIR" >/dev/null

echo "==> starting an image turn"
OUT="$(cd "$WORK_DIR" && paseo --home "$HOME_DIR" run --provider doubao --new-workspace local --no-wait \
  "生成一张 2048x2048 的精细科幻城市图片，保存为 ${WORK_DIR}/city.png")"
printf '%s\n' "$OUT"
AGENT_ID="$(printf '%s\n' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[ -n "$AGENT_ID" ] || fail "no agent id"

sleep 8
BEFORE="$(count_marked)"
echo "==> marked processes before stop: ${BEFORE}"
[ "$BEFORE" -gt 0 ] || fail "expected a running Doubao process"

paseo --home "$HOME_DIR" stop "$AGENT_ID" >/dev/null || fail "stop failed"
sleep 2
AFTER="$(count_marked)"
echo "==> marked processes after stop:  ${AFTER}"
[ "$AFTER" -eq 0 ] || fail "${AFTER} Doubao process(es) survived the interrupt"

STATUS="$(paseo --home "$HOME_DIR" ls --json | python3 -c '
import json, sys
agent = sys.argv[1]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("agents", [])
for item in items:
    if item.get("id") == agent:
        print(item.get("status") or item.get("lifecycle") or "")
        break
' "$AGENT_ID")"

echo "==> agent status: ${STATUS}"
[ "$STATUS" = "idle" ] || fail "agent did not return to idle (got ${STATUS})"

echo "PASS: interrupt stopped the turn and left no Doubao processes"
