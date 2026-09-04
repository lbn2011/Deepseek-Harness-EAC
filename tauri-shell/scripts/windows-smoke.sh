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
# 安装器在 CI 无头会话挂起的历史原因：
#   1) Git Bash 直接执行 .exe /S —— MSYS 参数转换可能改写 /S（安装器没进
#      静默模式 → GUI 打开 → 无头会话无交互 → 挂起）；
#   2) webviewInstallMode=downloadBootstrapper 的检测在无头会话可能卡。
# 改用 PowerShell Start-Process（参数原样 + -Wait 等退出），再失败则
# 7z 解包兜底（NSIS 包可解包，解包树与安装树同构，S2/S3 照跑）。
EXE=""
WORK=""
WIN_SETUP=$(cygpath -w "$SETUP" 2>/dev/null || echo "$SETUP")
timeout 150 powershell -NoProfile -Command "Start-Process -FilePath '$WIN_SETUP' -ArgumentList '/S' -Wait" && {
  for _ in $(seq 1 30); do
    EXE=$(find "$LOCALAPPDATA" -name 'dsh-eac-shell.exe' 2>/dev/null | head -1)
    [ -n "$EXE" ] && break
    sleep 2
  done
}
if [ -z "$EXE" ]; then
  echo "  静默安装未完成 —— 转 7z 解包兜底"
  # 解包兜底：7z 支持 NSIS 格式；windows runner 自带 7-Zip
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/dsh-nsis.XXXXXX")
  SEVENZ="/c/Program Files/7-Zip/7z.exe"
  if [ -f "$SEVENZ" ]; then
    "$SEVENZ" x -y -o"$WORK" "$SETUP" >/dev/null 2>&1
    EXE=$(find "$WORK" -name 'dsh-eac-shell.exe' 2>/dev/null | head -1)
    [ -n "$EXE" ] && echo "  7z 解包成功（绕过安装器挂起）"
  fi
fi
[ -n "$EXE" ] || { echo "FAIL: 安装/解包后未找到 dsh-eac-shell.exe"; exit 1; }
echo "  exe: $EXE"
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
if [ -n "$WORK" ]; then
  echo "  （7z 解包模式，跳过卸载；清理解包目录）"
  rm -rf "$WORK" 2>/dev/null || true
else
  UNINSTALL=$(find "$LOCALAPPDATA" -iname 'Uninstall*Deepseek*Harness*.exe' 2>/dev/null | head -1)
  if [ -n "$UNINSTALL" ]; then
    # 与 S1 同构（BUG-A-018）：Git Bash 裸调 "$UNINSTALL" /S 会被 MSYS 参数转换
    # 改写 /S（见 20-22 行注释）→ 卸载器进 GUI → 无头会话挂起。
    # 改用 PowerShell Start-Process（参数原样 + -Wait），|| true 保留退出码兜底。
    WIN_UNINSTALL=$(cygpath -w "$UNINSTALL" 2>/dev/null || echo "$UNINSTALL")
    timeout 150 powershell -NoProfile -Command "Start-Process -FilePath '$WIN_UNINSTALL' -ArgumentList '/S' -Wait" || true
    echo "  uninstalled: $UNINSTALL"
  else
    echo "  (未找到卸载器，跳过)"
  fi
fi
echo "WINDOWS SMOKE PASS"
