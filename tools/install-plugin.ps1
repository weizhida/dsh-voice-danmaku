# ============================================================================
# 一键安装到 DSH（桌面端）
# ============================================================================
# 做三件事：
#   1. 编译 TypeScript 插件与 C# 原生层；
#   2. 把插件以 link: 方式装进 DSH 的 desktop profile（软链，改代码不用重装）；
#   3. 打印重启提示与重启后要去哪填配置。
#
# 为什么用 link: 而不是复制：开发阶段改完源码只需重新 build，不需要重装插件。
#
# ⚠️ 必须用**桌面端自带的 CLI**，不能用 npm 上的 `dsh`：
#    后者是网页版提供的，它会拒绝操作桌面端的 profile
#    （报 profile "desktop" is managed exclusively by the Electron application），
#    而且它会把插件装进 web profile —— 桌面端根本不会读那里。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-plugin.ps1
#   powershell ... -File tools/install-plugin.ps1 -DshHome 'D:\DeepSeekHarness'
#
# 注意：本文件必须以 **UTF-8 with BOM** 保存（PowerShell 5.1 会把无 BOM 的
# UTF-8 按 ANSI/GBK 读，中文会乱码并可能破坏语法）。
# ============================================================================
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Output "插件目录: $root"

# --- 1. 编译 ---------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Output ''
  Write-Output '[1/3] 编译 TypeScript 插件'
  Push-Location $root
  try {
    & npx --no-install tsc -p tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw "TypeScript 编译失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }

  Write-Output '[2/3] 编译 C# 原生层'
  Push-Location $root
  try {
    & node sidecar/build.mjs
    if ($LASTEXITCODE -ne 0) { throw "sidecar 编译失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
} else {
  Write-Output '[1/3][2/3] 跳过编译（-SkipBuild）'
}

# --- 2. 安装到 profile -----------------------------------------------------
Write-Output "[3/3] 安装到 profile: $Profile"

# 桌面端自带的 CLI。找它的顺序按"可靠性"排：
#   1. 调用方显式给的 -DshHome；
#   2. 正在运行的 DSH 进程所在的目录（最可靠 —— 用户此刻就在用它）；
#   3. 几个常见安装位置。
function Find-DesktopCli {
  param([string]$Hint)

  $candidates = New-Object System.Collections.Generic.List[string]

  if ($Hint) {
    $candidates.Add((Join-Path $Hint 'resources\runtime\cli\bin\dsh.cmd'))
  }

  # 正在运行的进程：从可执行文件路径反推安装目录。
  try {
    $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path } | Select-Object -First 1
    if ($proc) {
      $dir = Split-Path -Parent $proc.Path
      $candidates.Add((Join-Path $dir 'resources\runtime\cli\bin\dsh.cmd'))
    }
  } catch {
    # 拿不到进程信息不算错，继续试其它位置。
  }

  $candidates.AddRange([string[]]@(
    'D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd')
  ))

  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

$cli = Find-DesktopCli -Hint $DshHome
if (-not $cli) {
  throw @"
找不到桌面端自带的 CLI。

请用 -DshHome 显式指定 DSH 的安装目录，例如：
  powershell -ExecutionPolicy Bypass -File tools/install-plugin.ps1 -DshHome 'D:\DeepSeekHarness'

（要找的是 <安装目录>\resources\runtime\cli\bin\dsh.cmd）
"@
}
Write-Output "  使用 CLI: $cli"

# 这个 CLI 会把参数转发给 profile 目录里的 pnpm，所以用 link: 指向本目录。
& $cli plugin --profile $Profile add "link:$root"
if ($LASTEXITCODE -ne 0) {
  throw @"
安装失败（退出码 $LASTEXITCODE）。

也可以手工执行同一条命令：
  & "$cli" plugin --profile $Profile add "link:$root"

注意：不要用 npm 上的 dsh —— 那是网页版，它拒绝操作桌面端的 profile。
"@
}

# --- 3. 收尾提示 -----------------------------------------------------------
# 这一段是整个安装流程里唯一"用户一定会看到"的输出：README 是可能被跳过的，
# 但脚本的输出就摆在眼前。所以"还差哪几步"和风险提示都放在这里，而不是只写
# 在文档里 —— 用 AI 助手装这个插件的人，也一定会看到这段输出。
#
# ffmpeg 只查 PATH：插件自己的探测（src/ffmpeg.ts）会查更多位置（winget / scoop /
# choco 的安装目录等），所以这里查不到**不等于**插件找不到。措辞必须留余地，
# 否则用户会去重复安装一遍。
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source

Write-Output ''
Write-Output '============================================================'
Write-Output ' 安装完成。还差这几步才能真正用起来 —— 都需要你自己做。'
Write-Output ''
Write-Output ' [1] 重启 DSH（不重启插件不会加载）'
Write-Output '       托盘图标右键退出，确认任务管理器里所有 "DeepSeek Harness" 进程'
Write-Output '       都结束了，再用平时的方式启动。只关窗口不算重启。'
Write-Output ''
Write-Output ' [2] 填语音识别的 API 密钥'
Write-Output '       设置 -> 语音弹幕 -> 识别服务 -> API 密钥'
Write-Output '       需要一个 OpenAI 兼容的识别服务。作者用的是硅基流动的'
Write-Output '       Qwen/Qwen3-ASR-1.7B（该平台有免费额度），你也可以选别的。'
Write-Output ''
Write-Output ' [3] 装 Chrome 扩展，并把端口与口令填进去'
Write-Output '       chrome://extensions -> 打开开发者模式 -> 加载已解压的扩展程序'
Write-Output "       选这个目录：$root\extension"
Write-Output '       再点扩展图标，把 设置 -> 语音弹幕 -> 发送通道 里的'
Write-Output '       「本地桥端口」与「本地桥口令」填进去（端口默认 39217）。'
Write-Output '       口令**不会自动生成** —— 那一栏是空的就先自己填一串，'
Write-Output '       扩展弹窗里要填同一份，两边必须一致。'
Write-Output ''
Write-Output ' [4] 打开一个已登录的 B 站直播间页面，并让它一直开着'
Write-Output '       弹幕是这个页面替你发出去的，页面关掉就发不了。'
Write-Output ''
Write-Output ' [5] 允许 DSH 使用麦克风'
Write-Output '       Windows 设置 -> 隐私和安全性 -> 麦克风 -> 允许桌面应用访问。'
Write-Output ''
if ($ffmpeg) {
  Write-Output " [6] ffmpeg：已找到 $ffmpeg"
} else {
  Write-Output ' [6] ffmpeg：没在 PATH 里找到（录音需要它）'
  Write-Output '       winget install Gyan.FFmpeg'
  Write-Output '       （插件还会自己查 winget / scoop / choco 的安装目录，装在别处也能找到）'
}
Write-Output ''
Write-Output ' 装完先跑一次自检 —— 它会录一小段话并真的调用识别服务：'
Write-Output '       npm run test-asr'
Write-Output ''
Write-Output '------------------------------------------------------------'
Write-Output ' ！风险提示：本插件会模拟你在直播间的操作，并绕过游戏的常规输入通道。'
Write-Output '   可能触发游戏反作弊或 B 站风控，导致账号封禁 —— 使用风险自负。'
Write-Output '============================================================'
