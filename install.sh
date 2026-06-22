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
  if [ "$DMG_ARCH" = "x64" ]; then
    echo "目前仅发布 Apple Silicon 版（Intel / x64 暂未提供）。"
  else
    echo "未找到 ${DMG_ARCH} 架构的 dmg。见 https://github.com/$REPO/releases"
  fi
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

# 本地推理运行时（llama.cpp）：未检测到则自动经 llama.app 官方脚本安装（与解析逻辑一致：
# PATH + ~/.local/bin + 常见包管理路径）。失败不阻断——App「模型」页仍可一键重试。
have_llama() {
  for n in llama-server llama; do
    command -v "$n" >/dev/null 2>&1 && return 0
    for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin /usr/bin; do
      [ -x "$d/$n" ] && return 0
    done
  done
  return 1
}
if have_llama; then
  echo "→ 已检测到本地推理运行时（llama）"
else
  echo "→ 未检测到 llama 运行时，正在经 llama.app 安装…"
  if curl -LsSf https://llama.app/install.sh | sh; then
    echo "→ llama 运行时安装完成"
  else
    echo "  ⚠ llama 自动安装未成功，可稍后在 App「模型」页一键安装，或手动："
    echo "    curl -LsSf https://llama.app/install.sh | sh"
  fi
fi

echo ""
echo "✓ 已安装：$DEST/EasyWork.app"
echo "  启动：open -a EasyWork  （或在启动台 / 访达里打开）"
