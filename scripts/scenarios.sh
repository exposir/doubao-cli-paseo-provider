#!/usr/bin/env bash
#
# General-scenario suite on a throwaway daemon:
#   quick answer, news search, file write, code reading, multi-turn recall,
#   image generation, and a long multi-step task with a concurrency probe.
#
#   bash scripts/scenarios.sh
#
# Costs 7 model calls plus one image. The long task is capped at 10 minutes.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paseo-scenarios.XXXXXX")"
WORK_DIR="${HOME_DIR}/workspace"
PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
export DOUBAO_PASEO_MAX_TURNS=1

cleanup() {
  paseo --home "$HOME_DIR" daemon stop >/dev/null 2>&1 || true
  [ "${PASEO_E2E_KEEP:-0}" = "1" ] && echo "keep: ${HOME_DIR}" || rm -rf "$HOME_DIR"
}
trap cleanup EXIT

FAILED=0
declare -a RESULTS

fail() {
  local name="$1" detail="$2"
  FAILED=$((FAILED + 1))
  RESULTS+=("FAIL  ${name}  ${detail}")
  echo "FAIL: ${name}: ${detail}" >&2
}

pass() {
  RESULTS+=("PASS  $1  $2")
}

agent_id() {
  grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1
}

run_turn() {
  local prompt="$1" timeout_s="${2:-300}"
  (cd "$WORK_DIR" && timeout "$timeout_s" paseo --home "$HOME_DIR" run \
    --provider doubao --new-workspace local "$prompt")
}

logs_of() {
  paseo --home "$HOME_DIR" logs "$1" 2>/dev/null
}

status_of() {
  paseo --home "$HOME_DIR" ls --json 2>/dev/null | python3 -c '
import json, sys
agent = sys.argv[1]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("agents", [])
for item in items:
    if item.get("id") == agent:
        print(item.get("status") or item.get("lifecycle") or "")
        break
' "$1"
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

rss_mb() {
  [ -r "/proc/$1/status" ] || { echo 0; return; }
  awk '/VmRSS/ {print int($2/1024)}' "/proc/$1/status"
}

mkdir -p "$WORK_DIR"
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" config user.name scenarios
git -C "$WORK_DIR" config user.email scenarios@local
git -C "$WORK_DIR" commit -q --allow-empty -m init

cat > "$WORK_DIR/calc.py" <<'PY'
def add(a, b):
    """Return the sum of two numbers."""
    return a + b
PY

cat > "$HOME_DIR/config.json" <<JSON
{
  "version": 1,
  "daemon": { "listen": "127.0.0.1:${PORT}", "relay": { "enabled": false } },
  "pluginsEnabled": true,
  "agents": { "providers": {} },
  "features": {}
}
JSON

echo "==> daemon 127.0.0.1:${PORT}"
paseo --home "$HOME_DIR" daemon start >/dev/null
paseo --home "$HOME_DIR" plugin install "$REPO_DIR" >/dev/null 2>&1
paseo --home "$HOME_DIR" project create "$WORK_DIR" >/dev/null

# 1. quick answer
started=$(date +%s)
OUT="$(run_turn '只回复：PONG' 120)" || true
ID="$(printf '%s' "$OUT" | agent_id)"
if [ -n "$ID" ] && logs_of "$ID" | grep -q 'PONG'; then
  pass "quick-answer" "$(( $(date +%s) - started ))s"
else
  fail "quick-answer" "no PONG in timeline"
fi

# 2. news search (tool use)
started=$(date +%s)
OUT="$(run_turn '今天有哪些新闻？只列一条，带来源。' 240)" || true
ID="$(printf '%s' "$OUT" | agent_id)"
TEXT="$(logs_of "$ID" | tail -n +2)"
if [ -n "$ID" ] && [ "$(printf '%s' "$TEXT" | wc -c)" -gt 40 ] && printf '%s' "$TEXT" | grep -qiE '新闻|http|报道'; then
  pass "news-search" "$(( $(date +%s) - started ))s"
else
  fail "news-search" "empty or failed: $(printf '%s' "$TEXT" | head -c 120)"
fi

# 3. file write
started=$(date +%s)
OUT="$(run_turn '在当前目录创建 hello.txt，内容写 hello-paseo，然后只回复 DONE' 180)" || true
ID="$(printf '%s' "$OUT" | agent_id)"
if [ -f "$WORK_DIR/hello.txt" ] && grep -q 'hello-paseo' "$WORK_DIR/hello.txt"; then
  pass "file-write" "$(( $(date +%s) - started ))s"
else
  fail "file-write" "hello.txt missing or wrong"
fi

# 4. read and explain code
started=$(date +%s)
OUT="$(run_turn '用一句话说明 calc.py 里 add 函数的作用。' 180)" || true
ID="$(printf '%s' "$OUT" | agent_id)"
if logs_of "$ID" | grep -qE '加|求和|sum|add'; then
  pass "read-code" "$(( $(date +%s) - started ))s"
else
  fail "read-code" "answer did not reference the function"
fi

# 5. multi-turn recall
started=$(date +%s)
OUT="$(run_turn '请记住暗号 ORANGE-42，只回复 OK。' 120)" || true
ID="$(printf '%s' "$OUT" | agent_id)"
if [ -n "$ID" ]; then
  (cd "$WORK_DIR" && timeout 180 paseo --home "$HOME_DIR" send "$ID" '暗号是什么？只回答暗号本身。') >/dev/null || true
  if logs_of "$ID" | grep -q 'ORANGE-42'; then
    pass "multi-turn" "$(( $(date +%s) - started ))s"
  else
    fail "multi-turn" "secret not recalled"
  fi
else
  fail "multi-turn" "no agent"
fi

# 6. image generation
started=$(date +%s)
OUT="$(run_turn '生成一张 512x512 的纯蓝色圆形图标，保存为 icon-test.png，然后只回复 DONE' 300)" || true
ID="$(printf '%s' "$OUT" | agent_id)"
if [ -f "$WORK_DIR/icon-test.png" ]; then
  INFO="$(python3 - "$WORK_DIR/icon-test.png" <<'PY'
import struct, sys
data = open(sys.argv[1], "rb").read(33)
assert data[:8] == b"\x89PNG\r\n\x1a\n", "not png"
w, h = struct.unpack(">II", data[16:24])
print(f"{w}x{h}")
PY
)" && pass "image" "$INFO $(( $(date +%s) - started ))s" || fail "image" "invalid PNG"
else
  fail "image" "icon-test.png missing"
fi

# 7. long task + concurrency probe
started=$(date +%s)
LONG_PROMPT='请分 4 步完成：在当前目录创建 step1.txt、step2.txt、step3.txt、step4.txt，每个文件写入约 100 字的中文说明。全部完成后只回复 DONE。'
OUT="$(cd "$WORK_DIR" && timeout 60 paseo --home "$HOME_DIR" run --provider doubao --new-workspace local --no-wait "$LONG_PROMPT" 2>/dev/null)" || true
ID="$(printf '%s' "$OUT" | agent_id)"

if [ -n "$ID" ]; then
  PID=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do PID="$(worker_pid)"; [ -n "$PID" ] && break; sleep 1; done
  RSS_START="$(rss_mb "$PID")"; RSS_MAX="$RSS_START"
  sleep 8

  PROBE="$(cd "$WORK_DIR" && timeout 60 paseo --home "$HOME_DIR" run --provider doubao --new-workspace local '只回复：SECOND' 2>&1)" || true
  PROBE_ID="$(printf '%s' "$PROBE" | agent_id)"
  if { [ -n "$PROBE_ID" ] && logs_of "$PROBE_ID" | grep -qE 'Too many concurrent|TOO_MANY_TURNS'; } \
     || printf '%s' "$PROBE" | grep -qE 'TOO_MANY_TURNS|Too many concurrent'; then
    pass "concurrency-cap" "rejected while long task running"
  else
    fail "concurrency-cap" "second turn was not rejected"
  fi

  DEADLINE=$((started + 600))
  while :; do
    state="$(status_of "$ID")"
    if [ "$state" != "running" ] && [ -n "$state" ]; then break; fi
    [ "$(date +%s)" -ge "$DEADLINE" ] && break
    RSS_NOW="$(rss_mb "$PID")"
    [ "$RSS_NOW" -gt "$RSS_MAX" ] && RSS_MAX="$RSS_NOW"
    sleep 5
  done

  FILES=0
  for n in 1 2 3 4; do [ -f "$WORK_DIR/step${n}.txt" ] && FILES=$((FILES + 1)); done

  ELAPSED=$(( $(date +%s) - started ))
  if [ "$FILES" -eq 4 ] && logs_of "$ID" | grep -q 'DONE'; then
    GROWTH=$((RSS_MAX - RSS_START))
    [ "$GROWTH" -le 150 ] && pass "long-task" "${ELAPSED}s 4 files rss+${GROWTH}MB" || fail "long-task" "rss grew ${GROWTH}MB"
  else
    fail "long-task" "${FILES}/4 files, elapsed ${ELAPSED}s"
  fi
else
  fail "long-task" "agent not created"
fi

echo
echo "================ scenario summary ================"
printf '%s\n' "${RESULTS[@]}"
echo "=================================================="
[ "$FAILED" -eq 0 ] || { echo "${FAILED} scenario(s) failed"; exit 1; }
echo "PASS: all scenarios"
