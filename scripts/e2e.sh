#!/usr/bin/env bash
#
# End-to-end check: a throwaway Paseo daemon on its own port, the plugin
# installed from this directory, a real agent turn and a follow-up that proves
# the native Doubao session was resumed.
#
# Requires: doubao logged in, paseo on PATH, node on PATH.
# Costs two small model calls.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECT="${PASEO_E2E_EXPECT:-E2E-OK}"
TRANSPORT="${DOUBAO_PASEO_TRANSPORT:-stream-json}"
export DOUBAO_PASEO_TRANSPORT="$TRANSPORT"
PROMPT="只回复四个字符：${EXPECT}"
FOLLOW_UP="我刚才让你回复什么？只回答那个字符串"

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paseo-e2e.XXXXXX")"
PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"

cleanup() {
  paseo --home "$HOME_DIR" daemon stop >/dev/null 2>&1 || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

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

echo "==> daemon on 127.0.0.1:${PORT} (home: ${HOME_DIR}, transport: ${TRANSPORT})"
paseo --home "$HOME_DIR" daemon start >/dev/null

echo "==> installing plugin"
paseo --home "$HOME_DIR" plugin install "$REPO_DIR" >/dev/null

echo "==> registering project"
paseo --home "$HOME_DIR" project create "$REPO_DIR" >/dev/null

echo "==> provider status"
paseo --home "$HOME_DIR" provider ls | grep -E '^doubao\s' || {
  echo "FAIL: doubao provider is not registered"
  exit 1
}

echo "==> first turn"
RUN_OUTPUT="$(cd "$REPO_DIR" && paseo --home "$HOME_DIR" run --provider doubao --new-workspace local "$PROMPT")"
printf '%s\n' "$RUN_OUTPUT"

AGENT_ID="$(printf '%s\n' "$RUN_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
if [ -z "$AGENT_ID" ]; then
  echo "FAIL: could not find the agent id in the run output"
  exit 1
fi

LOGS="$(paseo --home "$HOME_DIR" logs "$AGENT_ID")"
printf '%s\n' "$LOGS"
printf '%s' "$LOGS" | grep -q "$EXPECT" || {
  echo "FAIL: the first turn did not produce ${EXPECT}"
  exit 1
}

echo "==> follow-up (session resume)"
paseo --home "$HOME_DIR" send "$AGENT_ID" "$FOLLOW_UP" >/dev/null
LOGS_AFTER="$(paseo --home "$HOME_DIR" logs "$AGENT_ID")"

printf '%s' "$LOGS_AFTER" | tail -n 3 | grep -q "$EXPECT" || {
  echo "FAIL: the follow-up lost the conversation context"
  printf '%s\n' "$LOGS_AFTER"
  exit 1
}

echo "PASS: turn, streaming timeline and resume all worked"
