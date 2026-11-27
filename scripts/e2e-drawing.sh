#!/usr/bin/env bash
#
# 完整的「绘画」端到端流程，跑在一次性 Paseo daemon 上：
#
#   1. 隔离 daemon（随机端口 + 临时 home），安装插件
#   2. 第一轮：生成一张图片，校验 PNG 魔数、尺寸、体积
#   3. 第二轮：不重新画，描述刚才那张图，校验上下文（--resume）还在
#   4. 第三轮：画同一只猫的夜景版本，校验第二张图存在且与第一张不同
#   5. 汇总输出，清理 daemon
#
# 需要：doubao 已登录、paseo / node / python3 在 PATH 上。
# 会产生 2 次图片生成 + 1 次纯文本调用。
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paseo-draw.XXXXXX")"
WORK_DIR="${HOME_DIR}/workspace"
ARTIFACT_DIR="${PASEO_DRAW_ARTIFACTS:-/tmp/doubao-drawing-artifacts}"
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
  if [ "${PASEO_E2E_KEEP:-0}" = "1" ]; then
    echo "保留测试目录: ${HOME_DIR}"
  else
    rm -rf "$HOME_DIR"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if [ -f "${HOME_DIR}/daemon.log" ]; then
    echo "--- daemon.log 末尾 ---" >&2
    tail -n 15 "${HOME_DIR}/daemon.log" >&2
  fi
  exit 1
}

png_info() {
  python3 - "$1" <<'PY'
import struct, sys, os
path = sys.argv[1]
data = open(path, "rb").read(33)
if data[:8] != b"\x89PNG\r\n\x1a\n":
    print("not-a-png")
    sys.exit(1)
width, height = struct.unpack(">II", data[16:24])
print(f"{width}x{height} {os.path.getsize(path)}")
PY
}

mkdir -p "$WORK_DIR"
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" config user.name draw-e2e
git -C "$WORK_DIR" config user.email draw-e2e@local
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

echo "=============================================================="
echo " 绘画 E2E: daemon 127.0.0.1:${PORT}"
echo " workspace: ${WORK_DIR}"
echo "=============================================================="

echo "==> [1/6] 启动 daemon"
paseo --home "$HOME_DIR" daemon start >/dev/null || fail "daemon 启动失败"

echo "==> [2/6] 安装插件"
paseo --home "$HOME_DIR" plugin install "$REPO_DIR" >/dev/null 2>&1 || fail "插件安装失败"
paseo --home "$HOME_DIR" plugin ls | grep -q 'doubao-cli-paseo.*running' || fail "插件没有进入 running"

echo "==> [3/6] 注册项目并确认 provider"
paseo --home "$HOME_DIR" project create "$WORK_DIR" >/dev/null
paseo --home "$HOME_DIR" provider ls | grep -qE '^doubao\s' || fail "doubao provider 未注册"

echo "==> [4/6] 第一轮：生成图片"
IMG1="${WORK_DIR}/cat-sunset.png"
RUN1="$(cd "$WORK_DIR" && timeout 300 paseo --home "$HOME_DIR" run --provider doubao --new-workspace local \
  "画一张图：一只橘色的猫坐在窗台上看夕阳，暖色调，画面精致。直接生成图片并保存为 ${IMG1}")"
printf '%s\n' "$RUN1"

AGENT_ID="$(printf '%s\n' "$RUN1" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[ -n "$AGENT_ID" ] || fail "没有解析到 agent id"
[ -f "$IMG1" ] || fail "第一张图片不存在: ${IMG1}"

INFO1="$(png_info "$IMG1")" || fail "第一张图片不是合法 PNG"
W1="${INFO1%%x*}"
SIZE1="${INFO1##* }"
[ "$W1" -ge 512 ] 2>/dev/null || fail "第一张图片宽度过小: ${W1}"
[ "$SIZE1" -ge 100000 ] 2>/dev/null || fail "第一张图片体积过小: ${SIZE1} bytes"
echo "    OK  cat-sunset.png  ${INFO1%% *}  ${SIZE1} bytes"

echo "==> [5/6] 第二轮：描述刚才的画（不重新生成）"
timeout 200 paseo --home "$HOME_DIR" send "$AGENT_ID" \
  "不要重新画。用一句话描述你刚才生成的那张图：主体是什么、主色调是什么。" >/dev/null
LOGS2="$(paseo --home "$HOME_DIR" logs "$AGENT_ID")"
LAST2="$(printf '%s\n' "$LOGS2" | tail -n 3)"

printf '%s\n' "$LAST2"
printf '%s' "$LAST2" | grep -qE '猫|cat' || fail "第二轮回复没有提到猫，上下文可能丢失"
printf '%s' "$LAST2" | grep -qE '橘|橙|暖|夕|黄|金|红|晚霞|黄昏|sunset|orange|warm|gold' || fail "第二轮回复没有体现第一轮的画面特征，续聊失败"
echo "    OK  上下文保留（提到了猫与暖色/夕阳）"

echo "==> [6/6] 第三轮：画夜景版本"
IMG2="${WORK_DIR}/cat-night.png"
timeout 300 paseo --home "$HOME_DIR" send "$AGENT_ID" \
  "同一只橘猫，同样的构图，改成夜晚的窗台、冷色调月光，保存为 ${IMG2}" >/dev/null
[ -f "$IMG2" ] || fail "第二张图片不存在: ${IMG2}"

INFO2="$(png_info "$IMG2")" || fail "第二张图片不是合法 PNG"
SIZE2="${INFO2##* }"
[ "$SIZE2" -ge 100000 ] 2>/dev/null || fail "第二张图片体积过小: ${SIZE2} bytes"

HASH1="$(sha256sum "$IMG1" | cut -d' ' -f1)"
HASH2="$(sha256sum "$IMG2" | cut -d' ' -f1)"
[ "$HASH1" != "$HASH2" ] || fail "两张图片内容完全相同，第三轮没有真正重绘"
echo "    OK  cat-night.png   ${INFO2%% *}  ${SIZE2} bytes（与第一张不同）"

LOGS_ALL="$(paseo --home "$HOME_DIR" logs "$AGENT_ID")"
for needle in "画一张图" "不要重新画" "同一只橘猫"; do
  printf '%s' "$LOGS_ALL" | grep -q "$needle" || fail "时间线缺少这一轮: ${needle}"
done
TURNS=3

mkdir -p "$ARTIFACT_DIR"
cp "$IMG1" "$IMG2" "$ARTIFACT_DIR/"
echo
echo "=============================================================="
echo " PASS  绘画全流程"
echo "   agent:        ${AGENT_ID}"
echo "   轮次:         ${TURNS}"
echo "   cat-sunset:   ${INFO1}"
echo "   cat-night:    ${INFO2}"
echo "   产物副本:     ${ARTIFACT_DIR}"
echo "=============================================================="
