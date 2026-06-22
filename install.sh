#!/bin/sh
# EasyWork 一键安装（macOS）。用法：
#   curl -LsSf https://raw.githubusercontent.com/LunarCache/easywork/main/install.sh | sh
#
# 从主仓公开 Releases 下载对应架构的 dmg，安装到 /Applications（或 ~/Applications）。
# 初版未签名 → 安装后去除 quarantine，避免 Gatekeeper 拦截。
set -eu

REPO="${EASYWORK_REPO:-LunarCache/easywork}"
OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS" != "Darwin" ]; then
  echo "目前仅发布 macOS 版（Linux / Windows 即将支持）。"
  echo "可手动从 https://github.com/$REPO/releases 获取。"
  exit 1
fi

case "$ARCH" in
  arm64 | aarch64) DMG_ARCH="aarch64" ;;
  x86_64 | amd64) DMG_ARCH="x64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

echo "→ 查询最新版本…"
API="https://api.github.com/repos/$REPO/releases/latest"
URL="$(curl -fsSL "$API" | grep -oE "https://[^\"]+_${DMG_ARCH}\\.dmg" | head -1)"
if [ -z "$URL" ]; then
  echo "未找到 ${DMG_ARCH} 架构的 dmg（该架构可能尚未发布）。见 https://github.com/$REPO/releases"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DMG="$TMP/EasyWork.dmg"
echo "→ 下载 $URL"
curl -fSL "$URL" -o "$DMG"

echo "→ 挂载 dmg"
MNT="$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | tail -1)"
if [ -z "$MNT" ] || [ ! -d "$MNT/EasyWork.app" ]; then
  echo "挂载或定位 EasyWork.app 失败"
  exit 1
fi

DEST="/Applications"
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  echo "→ /Applications 不可写，改装到 $DEST"
fi
echo "→ 安装到 $DEST/EasyWork.app"
rm -rf "$DEST/EasyWork.app"
cp -R "$MNT/EasyWork.app" "$DEST/"
hdiutil detach "$MNT" >/dev/null 2>&1 || true

# 未签名构建：移除 quarantine，避免 “已损坏 / 无法验证开发者” 提示。
xattr -dr com.apple.quarantine "$DEST/EasyWork.app" 2>/dev/null || true

echo ""
echo "✓ 已安装：$DEST/EasyWork.app"
echo "  启动：open -a EasyWork  （或在启动台 / 访达里打开）"
echo "  首次运行会自动检测本地推理运行时（llama），缺失时可在「模型」页一键安装。"
