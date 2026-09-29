# ============================================================================
# 触发方式探针 —— 编译与运行
# ============================================================================
# 目的：在**不触碰反作弊**的前提下，找出哪种方式能在游戏里读到"按了什么"。
#
# 它同时用三种互不相同的机制测试：
#   1. GetAsyncKeyState 轮询 —— 直接查系统按键状态表，不走钩子链
#   2. 手柄 XInput           —— 另一套 API 与驱动，不是键盘 HID 栈
#   3. 低级键盘钩子          —— 已知会在游戏里失效，留着当对照基线
#
# 不注入游戏、不模拟输入、不 hook 游戏进程，只用 Windows 公开接口。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/probe-trigger.ps1
#   powershell -ExecutionPolicy Bypass -File tools/probe-trigger.ps1 -Args '--poll-only'
#
# 注意：本文件必须以 UTF-8 with BOM 保存（PowerShell 5.1 会把无 BOM 的
# UTF-8 当 ANSI/GBK 读，中文会乱码并可能破坏语法）。
# ============================================================================
param(
  [string]$Args = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root 'tools\trigger-probe\Program.cs'
$outDir = Join-Path $env:TEMP 'dsh-voice-danmaku-trigger-probe'
$exe = Join-Path $outDir 'trigger-probe.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$winForms = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll'
$drawing = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll'

if (-not (Test-Path $csc)) { throw "找不到 C# 编译器: $csc" }
if (-not (Test-Path $source)) { throw "找不到探针源码: $source" }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Output "编译探针…"
# /codepage:65001 必须有：源码是 UTF-8，不加这一项 csc 会按 ANSI 读，中文全乱码。
& $csc /nologo /codepage:65001 /target:exe /platform:x64 /out:$exe `
  /reference:$winForms /reference:$drawing $source
if ($LASTEXITCODE -ne 0) { throw "编译失败（退出码 $LASTEXITCODE）" }

Write-Output ''
if ($Args.Length -gt 0) {
  & $exe $Args.Split(' ')
} else {
  & $exe
}
