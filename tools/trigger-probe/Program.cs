// ============================================================================
// 触发方式探针 —— 三种"不走输入钩子链"的读取方式
// ============================================================================
// 背景：CFHD 这类内核反外挂会让低级钩子与 Raw Input 都读不到游戏里的按键。
// 但"读按键"不止一条路。本探针同时用三种互不相同的机制：
//
//   1. GetAsyncKeyState 轮询 —— 直接查系统按键状态表，没有钩子回调可拦。
//      代价是轮询间隔（这里 10ms）限制的时间分辨率。
//
//   2. XInput（手柄）—— 走 XInput 而不是键盘 HID 栈。反外挂通常只盯键盘鼠标，
//      手柄又是另一套驱动与 API，因此这条很值得测。
//
//   3. Raw Input + 低级钩子 —— 作为对照，已知在游戏里读不到。留着是为了
//      让输出能直接对比"哪个通、哪个不通"，而不是只看一个结果。
//
// 只读，不注入、不模拟输入、不碰游戏进程。
//
// 用法：
//   trigger-probe.exe              三种全测
//   trigger-probe.exe --poll-only  只测轮询
//   trigger-probe.exe --pad-only   只测手柄
// ============================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class TriggerProbe
{
    // --- 1. GetAsyncKeyState 轮询 -------------------------------------------
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    // --- 2. XInput ----------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    private struct XINPUT_GAMEPAD
    {
        public ushort wButtons;
        public byte bLeftTrigger;
        public byte bRightTrigger;
        public short sThumbLX;
        public short sThumbLY;
        public short sThumbRX;
        public short sThumbRY;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct XINPUT_STATE
    {
        public uint dwPacketNumber;
        public XINPUT_GAMEPAD Gamepad;
    }

    [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
    private static extern uint XInputGetState14(uint index, ref XINPUT_STATE state);

    // 老系统上可能只有 1_3 或 9_1_0，逐个回退。
    [DllImport("xinput1_3.dll", EntryPoint = "XInputGetState")]
    private static extern uint XInputGetState13(uint index, ref XINPUT_STATE state);

    private const uint ERROR_SUCCESS = 0;

    private static uint ReadPad(uint index, ref XINPUT_STATE state)
    {
        try { return XInputGetState14(index, ref state); }
        catch (DllNotFoundException)
        {
            try { return XInputGetState13(index, ref state); }
            catch (DllNotFoundException) { return 0xFFFFFFFF; }
        }
        catch (EntryPointNotFoundException)
        {
            try { return XInputGetState13(index, ref state); }
            catch { return 0xFFFFFFFF; }
        }
    }

    // --- 3. 低级键盘钩子（对照）--------------------------------------------
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    // --- 前台窗口 -----------------------------------------------------------
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    /// <summary>
    /// 要轮询的键。默认挑几个候选；用 `--keys 7C,7D` 可以只测指定的虚拟键码
    /// （十六进制）。测 G HUB 转发键时用得上：F13 = 0x7C，物理键盘上不存在，
    /// 游戏几乎不可能绑定它。
    /// </summary>
    private static readonly int[] DefaultKeys = new int[]
    {
        0x78, // F9
        0x79, // F10
        0x7A, // F11
        0x7C, // F13  ← G HUB 常用来做转发键
        0x7D, // F14
        0x14, // CapsLock
        0x91, // ScrollLock
        0x21, // PageUp
        0x22  // PageDown
    };

    private static int[] PollKeys = DefaultKeys;

    private static readonly Dictionary<int, string> KeyNames = new Dictionary<int, string>
    {
        { 0x78, "F9" }, { 0x79, "F10" }, { 0x7A, "F11" }, { 0x77, "F8" },
        { 0x7C, "F13" }, { 0x7D, "F14" }, { 0x7E, "F15" }, { 0x7F, "F16" },
        { 0x80, "F17" }, { 0x81, "F18" }, { 0x82, "F19" }, { 0x83, "F20" },
        { 0x84, "F21" }, { 0x85, "F22" }, { 0x86, "F23" }, { 0x87, "F24" },
        { 0x14, "CapsLock" }, { 0x91, "ScrollLock" },
        { 0xC0, "`~" }, { 0x21, "PageUp" }, { 0x22, "PageDown" }, { 0x2D, "Insert" },
        { 0x13, "Pause" }, { 0x90, "NumLock" }
    };

    private static volatile bool _running = true;
    private static string _lastForeground = "";
    private static long _pollHits;
    private static long _hookHits;
    private static long _padHits;

    [STAThread]
    private static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        bool pollOnly = Array.IndexOf(args, "--poll-only") >= 0;
        bool padOnly = Array.IndexOf(args, "--pad-only") >= 0;

        // --keys 7C,7D 只测指定的虚拟键码（十六进制）
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] != "--keys" || i + 1 >= args.Length) continue;
            var parsed = new List<int>();
            foreach (string token in args[i + 1].Split(','))
            {
                string trimmed = token.Trim();
                int value;
                if (trimmed.Length > 0 &&
                    int.TryParse(trimmed, System.Globalization.NumberStyles.HexNumber,
                        System.Globalization.CultureInfo.InvariantCulture, out value))
                {
                    parsed.Add(value);
                }
            }
            if (parsed.Count > 0) PollKeys = parsed.ToArray();
        }

        Console.WriteLine("== 触发方式探针 ==");
        Console.WriteLine("进程位数: " + (Environment.Is64BitProcess ? "64 位" : "32 位"));
        Console.WriteLine();

        // 先报手柄在不在
        var padState = new XINPUT_STATE();
        uint padResult = ReadPad(0, ref padState);
        bool padPresent = padResult == ERROR_SUCCESS;
        Console.WriteLine("手柄检测: " + (padPresent
            ? "已连接（XInput 端口 0）"
            : "未连接（XInput 返回 " + padResult + "）"));

        // 装钩子作对照
        IntPtr hook = IntPtr.Zero;
        LowLevelKeyboardProc proc = OnKeyboardHook;
        if (!pollOnly && !padOnly)
        {
            hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
            Console.WriteLine("低级键盘钩子（对照）: " + (hook != IntPtr.Zero ? "已安装" : "安装失败"));
        }

        Console.WriteLine();
        Console.WriteLine("== 测试步骤 ==");
        Console.WriteLine("先在这里按几下确认三种方式有反应，然后切进游戏按同样的键。");
        Console.WriteLine();
        Console.WriteLine("建议在游戏里试这几个键（挑你没绑定的）：");
        Console.WriteLine("  " + string.Join("  ", KeyNames.Values));
        Console.WriteLine();
        Console.WriteLine("如果有手柄，也请切进游戏按手柄的 A / B / 十字键。");
        Console.WriteLine("Ctrl+C 结束并打印汇总。");
        Console.WriteLine(new string('-', 78));
        Console.Out.Flush();

        // 轮询线程：GetAsyncKeyState 必须反复查，没有事件可等。
        var pollThread = new Thread(PollLoop) { IsBackground = true };
        pollThread.Start();

        // 手柄线程
        if (padPresent || padOnly)
        {
            var padThread = new Thread(PadLoop) { IsBackground = true };
            padThread.Start();
        }

        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e)
        {
            e.Cancel = true;
            _running = false;
            PrintSummary(padPresent);
            Environment.Exit(0);
        };

        // 消息循环：钩子需要它
        Application.EnableVisualStyles();
        Application.Run(new HiddenWindow());
    }

    private sealed class HiddenWindow : Form
    {
        public HiddenWindow()
        {
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
        }
    }

    /// <summary>轮询 GetAsyncKeyState。注意这是"当前是否按下"，不是事件。</summary>
    private static void PollLoop()
    {
        var wasDown = new Dictionary<int, bool>();

        while (_running)
        {
            foreach (int vk in PollKeys)
            {
                // 最高位为 1 表示当前按下
                bool down = (GetAsyncKeyState(vk) & 0x8000) != 0;
                bool previously;
                wasDown.TryGetValue(vk, out previously);

                if (down && !previously)
                {
                    _pollHits++;
                    string name;
                    KeyNames.TryGetValue(vk, out name);
                    Report("[轮询] " + (name ?? "VK_0x" + vk.ToString("X2")));
                }
                wasDown[vk] = down;
            }
            Thread.Sleep(10);   // 10ms ≈ 100 次/秒，足够人手按键
        }
    }

    /// <summary>轮询 XInput 手柄按键。</summary>
    private static void PadLoop()
    {
        ushort previous = 0;
        while (_running)
        {
            var state = new XINPUT_STATE();
            if (ReadPad(0, ref state) == ERROR_SUCCESS)
            {
                ushort buttons = state.Gamepad.wButtons;
                ushort pressed = (ushort)(buttons & ~previous);
                if (pressed != 0)
                {
                    _padHits++;
                    Report("[手柄] " + DescribeButtons(pressed) +
                        "  (全部=0x" + buttons.ToString("X4") + ")");
                }
                previous = buttons;
            }
            Thread.Sleep(15);
        }
    }

    private static string DescribeButtons(ushort buttons)
    {
        var names = new List<string>();
        if ((buttons & 0x1000) != 0) names.Add("A");
        if ((buttons & 0x2000) != 0) names.Add("B");
        if ((buttons & 0x4000) != 0) names.Add("X");
        if ((buttons & 0x8000) != 0) names.Add("Y");
        if ((buttons & 0x0100) != 0) names.Add("上");
        if ((buttons & 0x0200) != 0) names.Add("下");
        if ((buttons & 0x0400) != 0) names.Add("左");
        if ((buttons & 0x0800) != 0) names.Add("右");
        if ((buttons & 0x0010) != 0) names.Add("Start");
        if ((buttons & 0x0020) != 0) names.Add("Back");
        if ((buttons & 0x0040) != 0) names.Add("左摇杆按");
        if ((buttons & 0x0080) != 0) names.Add("右摇杆按");
        if ((buttons & 0x0001) != 0) names.Add("LB");
        if ((buttons & 0x0002) != 0) names.Add("RB");
        if (names.Count == 0) names.Add("0x" + buttons.ToString("X4"));
        return string.Join("+", names);
    }

    private static IntPtr OnKeyboardHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
            {
                var data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                string name;
                KeyNames.TryGetValue((int)data.vkCode, out name);
                if (name != null)
                {
                    _hookHits++;
                    Report("[钩子] " + name);
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    /// <summary>打印一行，并在前台窗口变化时插入标题，便于判断按键发生在哪。</summary>
    private static void Report(string message)
    {
        string foreground = ForegroundDescription();
        lock (typeof(TriggerProbe))
        {
            if (foreground != _lastForeground)
            {
                _lastForeground = foreground;
                Console.WriteLine();
                Console.WriteLine("--- 前台窗口切到: " + foreground + " ---");
            }
            Console.WriteLine(message);
            Console.Out.Flush();
        }
    }

    private static string ForegroundDescription()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return "(无前台窗口)";
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        string process = "?";
        try { process = Process.GetProcessById((int)pid).ProcessName; }
        catch { }
        var title = new StringBuilder(200);
        GetWindowText(hwnd, title, title.Capacity);
        string text = title.ToString();
        if (text.Length > 36) text = text.Substring(0, 36) + "…";
        return process + (text.Length > 0 ? " | " + text : "");
    }

    private static void PrintSummary(bool padPresent)
    {
        Console.WriteLine();
        Console.WriteLine(new string('-', 78));
        Console.WriteLine("汇总：");
        Console.WriteLine("  轮询 GetAsyncKeyState : " + _pollHits + " 次命中");
        Console.WriteLine("  低级键盘钩子（对照）  : " + _hookHits + " 次命中");
        Console.WriteLine("  手柄 XInput           : " + _padHits + " 次命中" +
            (padPresent ? "" : "（未检测到手柄）"));
        Console.WriteLine();
        Console.WriteLine("怎么读：如果某个方式在游戏里也有命中，它就能当触发器；");
        Console.WriteLine("钩子那一项预计在游戏里为 0（已知被反外挂挡住），用它当基线对比。");
    }
}
