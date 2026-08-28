#!/usr/bin/env bash
# Windows 产物冒烟（Task 11.3 扩展）：在 windows-latest runner 上——
#   S1 NSIS 安装包静默安装（/S，currentUser）
#   S2 安装树结构断言（exe / sidecar/server.js / dsh-desktop / vendored node）
#   S3 对话界面启动探活：vendored node 直启 sidecar/server.js → boot.start →
#      HTTP 首页 200 + 对话 UI 标记（复用 sidecar-boot-probe.js）
#   S4 卸载清理（NSIS 卸载器 /S）
#
# 用法：bash windows-smoke.sh <产物目录> <脚本目录>
#   产物目录含 NSIS *.exe（dsh-eac-windows-x64-ci.zip 解包）
set -euo pipefail

ART="${1:-/a}"
SCRIPTS="${2:-.}"

echo "== S1 NSIS 静默安装 =="
SETUP=$(find "$ART" -maxdepth 2 -name '*.exe' | head -1)
[ -n "$SETUP" ] || { echo "FAIL: 未找到 NSIS 安装包（$ART）"; exit 1; }
echo "  setup: $SETUP"
# 安装器可能在无头环境挂起（CI 实测 23min 未返回）：前台等待加超时。
# /S 静默安装完成后安装器进程退出；超时则打印进程表诊断。
timeout 240 "$SETUP" /S || {
  echo "FAIL: NSIS 安装器超时/失败（exit $?）—— 进程表："
  powershell -NoProfile -Command "Get-Process | Where-Object { \$_.ProcessName -match 'setup|Deepseek|dsh' } | Select-Object Id,ProcessName,StartTime | Format-Table" || true
  exit 1
}
# 等待安装完成（轮询 LOCALAPPDATA 下的 dsh-eac-shell.exe）
EXE=""
for _ in $(seq 1 90); do
  EXE=$(find "$LOCALAPPDATA" -name 'dsh-eac-shell.exe' 2>/dev/null | head -1)
  [ -n "$EXE" ] && break
  sleep 2
done
[ -n "$EXE" ] || { echo "FAIL: 安装后未找到 dsh-eac-shell.exe（LOCALAPPDATA=$LOCALAPPDATA）"; exit 1; }
echo "  installed: $EXE"
INSTALL_DIR=$(dirname "$EXE")

echo "== S2 安装树结构断言 =="
SERVER=$(find "$INSTALL_DIR" -path '*/sidecar/server.js' | head -1)
NODE=$(find "$INSTALL_DIR" -path '*/dsh-desktop/vendor/node/node.exe' | head -1)
[ -n "$SERVER" ] || { echo "FAIL: 安装树缺 sidecar/server.js"; exit 1; }
[ -n "$NODE" ] || { echo "FAIL: 安装树缺 vendored node（dsh-desktop/vendor/node/node.exe）"; exit 1; }
echo "  ok: $EXE"
echo "  ok: $SERVER"
echo "  ok: $NODE"

echo "== S3 对话界面启动探活 =="
# sidecar 直启需要 DSH_DESKTOP_RESOURCE_ROOT 指向安装树（server.js 探测不到
# 时用环境变量兜底）；探活脚本会临时建 DSH_HOME。
DSH_DESKTOP_RESOURCE_ROOT="$INSTALL_DIR/dsh-desktop" \
"$NODE" "$SCRIPTS/sidecar-boot-probe.js" "$SERVER" 240

echo "== S4 卸载清理 =="
UNINSTALL=$(find "$LOCALAPPDATA" -iname 'Uninstall*Deepseek*Harness*.exe' 2>/dev/null | head -1)
if [ -n "$UNINSTALL" ]; then
  "$UNINSTALL" /S || true
  echo "  uninstalled: $UNINSTALL"
else
  echo "  (未找到卸载器，跳过)"
fi
echo "WINDOWS SMOKE PASS"
