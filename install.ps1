# EasyWork 一键安装（Windows）。用法：
#   irm https://raw.githubusercontent.com/LunarCache/easywork/main/install.ps1 | iex
#
# 注：首个发布版本仅含 macOS。Windows 安装包（.msi/.exe）发布后本脚本将自动下载安装。
$ErrorActionPreference = "Stop"
$Repo = if ($env:EASYWORK_REPO) { $env:EASYWORK_REPO } else { "LunarCache/easywork" }

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
Write-Host "→ 查询最新版本…"
$rel = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases/latest"
$asset = $rel.assets | Where-Object { $_.name -match "_$arch.*\.(msi|exe)$" } | Select-Object -First 1

if (-not $asset) {
  Write-Host "尚未发布 Windows 版（当前仅 macOS）。"
  Write-Host "请关注 https://github.com/$Repo/releases"
  return
}

$tmp = Join-Path $env:TEMP $asset.name
Write-Host "→ 下载 $($asset.browser_download_url)"
Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $tmp
Write-Host "→ 启动安装程序"
Start-Process -FilePath $tmp -Wait
Write-Host "✓ 安装完成。"
