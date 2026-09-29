# ============================================================================
# 媒体键探针 —— 编译与运行
# ============================================================================
# 目的：验证媒体键（静音/音量/播放）能否在游戏里读到。
#
# 为什么它和普通按键不同：媒体键走 HID 的 **Consumer Control 用法页（0x0C）**，
# 普通按键走键盘用法页（0x06）。反作弊很可能只挂钩了后者 —— 实测也表明
# 静音键在游戏里有反应，而普通键没有。
#
# 探针同时用四条互不相同的路径读取，一次看清哪条通：
#   1. RegisterHotKey  —— 全局热键，不要求本进程前台（最有希望）
#   2. 低级键盘钩子     —— 媒体键也会以 VK 0xAD~0xAF 经过钩子链
#   3. GetAsyncKeyState —— 不走钩子链，直接查状态表
#   4. Raw Input 0x0C   —— 直接订阅 Consumer Control 用法页
#
# 只读：不注入、不模拟输入、不 hook 游戏进程。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/probe-media.ps1
#
# 注意：本文件必须以 UTF-8 with BOM 保存（PowerShell 5.1 会把无 BOM 的
# UTF-8 当 ANSI/GBK 读，中文会乱码并可能破坏语法）。
# ============================================================================

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root 'tools\media-probe\Program.cs'
$outDir = Join-Path $env:TEMP 'dsh-voice-danmaku-media-probe'
$exe = Join-Path $outDir 'media-probe.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$winForms = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll'
$drawing = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll'

if (-not (Test-Path $csc)) { throw "找不到 C# 编译器: $csc" }
if (-not (Test-Path $source)) { throw "找不到探针源码: $source" }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Output "编译探针…"
& $csc /nologo /codepage:65001 /target:exe /platform:x64 /out:$exe `
  /reference:$winForms /reference:$drawing $source
if ($LASTEXITCODE -ne 0) { throw "编译失败（退出码 $LASTEXITCODE）" }

Write-Output ''
& $exe
