# ============================================================================
# 输入设备工具 —— 编译与运行
# ============================================================================
# 两个模式：
#
#   1. rawinput（默认）—— 验证"游戏占用焦点时还能不能读到按键"
#      这是决定"按设备过滤"这条路值不值得做的关键实验。
#
#   2. devices —— 列出输入设备，并显示每个按键来自哪个设备
#      用来判断某个键是不是独立设备。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/probe-input.ps1
#   powershell -ExecutionPolicy Bypass -File tools/probe-input.ps1 -Mode devices
#   powershell -ExecutionPolicy Bypass -File tools/probe-input.ps1 -Mode devices -ListOnly
#
# 只读不拦：不会屏蔽或改写任何输入，不影响正常使用。
#
# 注意：本文件必须以 UTF-8 with BOM 保存（PowerShell 5.1 会把无 BOM 的
# UTF-8 当 ANSI/GBK 读，中文会乱码并可能破坏语法）。
# ============================================================================
param(
  # rawinput = 验证穿透；devices = 列出设备来源
  [ValidateSet('rawinput', 'devices')]
  [string]$Mode = 'rawinput',

  # devices 模式：只列设备不监听
  [switch]$ListOnly,

  # 只显示设备路径里含这个字串的事件，例如 -Filter C232
  [string]$Filter = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sourceDir = Join-Path $root 'tools\input-probe'
$outDir = Join-Path $env:TEMP 'dsh-voice-danmaku-input-probe'
$exe = Join-Path $outDir 'input-tool.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$winForms = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll'
$drawing = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll'

if (-not (Test-Path $csc)) { throw "找不到 C# 编译器: $csc" }

# 两个源文件各有入口点。用 /main 指定参与的那个，
# 另一个文件里的 Main 就不算冲突。
$sources = Get-ChildItem $sourceDir -Filter '*.cs' | Select-Object -ExpandProperty FullName
if ($sources.Count -eq 0) { throw "在 $sourceDir 下没找到 .cs 源文件" }

$entry = if ($Mode -eq 'rawinput') { 'RawInputProbe' } else { 'InputProbe' }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Output "模式: $Mode   入口: $entry"
Write-Output "编译…"

# /codepage:65001 必须有：源码是 UTF-8，不加这一项 csc 会按 ANSI 读，中文全乱码。
& $csc /nologo /codepage:65001 /target:exe /platform:x64 /main:$entry `
  /out:$exe /reference:$winForms /reference:$drawing $sources
if ($LASTEXITCODE -ne 0) { throw "编译失败（退出码 $LASTEXITCODE）" }

Write-Output ''
if ($Mode -eq 'devices') {
  $extra = @()
  if ($ListOnly) { $extra += '--list' }
  & $exe @extra
} else {
  $extra = @()
  if ($Filter.Length -gt 0) { $extra += @('--vid', $Filter) }
  & $exe @extra
}
