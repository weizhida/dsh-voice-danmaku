# ============================================================================
# 按键注入器 —— 仅用于自动化测试
# ============================================================================
# 用 Win32 的 keybd_event 合成一次按键，再发一个可见字符给前台窗口，
# 把低频键盘钩子（WH_KEYBOARD_LL）从"挂起"状态唤醒。
#
# 为什么需要这个：Windows 对低级键盘钩子按需唤醒，而"需要唤醒"的前提是它
# 收到过输入。在没有真实按键的情况下验证钩子链路时，注入一次输入是最接近
# 真实的做法。
#
# 它**不能**替代真机验证：合成输入绕过硬件，因此测不出"某个游戏用内核级输入
# 或反作弊挡住钩子"这类问题。它验证的是协议、订阅与分发链路。
#
# 注意：本文件必须以 **UTF-8 with BOM** 保存。PowerShell 5.1 会把无 BOM 的
# UTF-8 当成 ANSI（中文系统上是 GBK）来读，中文注释会变成乱码并可能破坏语法。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/inject-key.ps1 -Code 120
# ============================================================================
param(
  [Parameter(Mandatory = $true)][int]$Code
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KeyInjector {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const uint KEYEVENTF_KEYUP = 0x0002;

    /// <summary>Synthesize one press+release.</summary>
    public static void Tap(byte virtualKey) {
        keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(virtualKey, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
'@

# 合成按键。全局钩子会看到它，与真实按键走同一条内核路径。
[KeyInjector]::Tap([byte]$Code)

# 发一个可见字符给前台窗口，唤醒挂起的低级钩子。
try {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait(' ')
} catch {
  # 没有前台窗口时 SendKeys 可能失败；合成按键本身已经发出，不算致命。
}

Write-Output "injected vk=$Code"
