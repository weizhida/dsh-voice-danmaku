# ============================================================================
# 一键安装到 DSH
# ============================================================================
# 做三件事：
#   1. 编译 TypeScript 插件与 C# 原生层；
#   2. 把插件以 link: 方式装进 DSH 的 web profile（软链，改代码不用重装）；
#   3. 打印重启提示与重启后要去哪填配置。
#
# 为什么用 link: 而不是复制：开发阶段改完源码只需重新 build，不需要重装插件。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-plugin.ps1
#   powershell ... -File tools/install-plugin.ps1 -Profile tui     # 装到别的 profile
#
# 注意：本文件必须以 **UTF-8 with BOM** 保存（PowerShell 5.1 会把无 BOM 的
# UTF-8 按 ANSI/GBK 读，中文会乱码并可能破坏语法）。
# ============================================================================
param(
  [string]$Profile = 'web',
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
# dsh plugin 会把参数转发给 profile 目录里的 pnpm，所以这里用 link: 指向本目录。
& dsh plugin --profile $Profile add "link:$root"
if ($LASTEXITCODE -ne 0) {
  throw @"
安装失败（退出码 $LASTEXITCODE）。
如果提示找不到 dsh 命令，请确认 DeepSeek Harness 已安装并在 PATH 中。
也可以手工执行：
  dsh plugin --profile $Profile add "link:$root"
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
Write-Output '       关掉 DSH 窗口 / 结束 dsh 进程，再用平时的方式启动，并刷新 Web GUI。'
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
Write-Output '       「本地桥端口」与「本地桥口令」填进去（端口默认 39217，通常只需抄口令）。'
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
