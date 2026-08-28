#!/usr/bin/env bash
# Linux 产物冒烟（Task 11.3 / AC-8）：在干净 ubuntu:24.04 容器内验证——
#   L1 AppImage --appimage-extract 提取树关键路径断言（无 FUSE）
#   L2 deb dpkg -i 安装 / dpkg -L 关键路径 / dpkg -r 卸载干净
#   L3 sidecar boot 探活（vendored node 直启 server.js → boot.start → HTTP 200）
#
# 用法（容器内）：bash /scripts/linux-smoke.sh /a [/scripts]
#   /a        = 挂载的产物目录（含 *.AppImage / *.deb）
#   /scripts  = 挂载的脚本目录（含 sidecar-boot-probe.js）
set -euo pipefail

ART="${1:-/a}"
SCRIPTS="${2:-/scripts}"
# 产物挂载为只读（:ro）：先复制到容器可写工作目录，chmod/解包才能进行。
WORK="$(mktemp -d /tmp/dsh-smoke.XXXXXX)"
cp -a "$ART"/. "$WORK"/ 2>/dev/null || { echo "FAIL: 无法复制产物到工作目录"; exit 1; }
cd "$WORK"

echo "== L1 AppImage 提取 =="
APPIMAGE=$(find . -maxdepth 2 -name '*.AppImage' | head -1)
[ -n "$APPIMAGE" ] || { echo "FAIL: 未找到 AppImage"; exit 1; }
chmod +x "$APPIMAGE"
"$APPIMAGE" --appimage-extract >/dev/null
SROOT=squashfs-root
[ -d "$SROOT" ] || { echo "FAIL: extract 未产出 squashfs-root"; exit 1; }
for rel in "*/dsh-eac-shell" "*/sidecar/server.js" "*/dsh-desktop/node_modules/@deepseek-ai/dsh/package.json"; do
  found=$(find "$SROOT" -path "$rel" -print -quit 2>/dev/null || true)
  [ -n "$found" ] || { echo "FAIL: 提取树缺 $rel"; exit 1; }
  echo "  ok: $found"
done
echo "L1 PASS"

echo "== L2 deb 安装/卸载 =="
DEB=$(find . -maxdepth 2 -name '*.deb' | head -1)
[ -n "$DEB" ] || { echo "FAIL: 未找到 deb"; exit 1; }
PKG=$(dpkg-deb -f "$DEB" Package)
dpkg -i "$DEB" >/dev/null
dpkg -L "$PKG" | grep -qE 'dsh-eac-shell|sidecar/server\.js' || { echo "FAIL: deb 安装树缺关键路径"; exit 1; }
echo "  installed: $PKG"
dpkg -r "$PKG" >/dev/null
if dpkg -l "$PKG" 2>/dev/null | grep -q '^ii'; then echo "FAIL: 卸载残留 $PKG"; exit 1; fi
echo "L2 PASS"

echo "== L3 sidecar boot 探活 =="
NODE=$(find "$SROOT" -path '*/vendor/node/bin/node' -type f | head -1)
SERVER=$(find "$SROOT" -path '*/sidecar/server.js' -type f | head -1)
[ -n "$NODE" ] && [ -n "$SERVER" ] || { echo "FAIL: 未找到 vendored node 或 sidecar/server.js"; exit 1; }
"$NODE" "$SCRIPTS/sidecar-boot-probe.js" "$SERVER" 180
echo "L3 PASS"

echo "LINUX-SMOKE: ALL PASS"
