// ============================================================================
// 媒体键探针 —— 测试 Consumer Control 键能否在游戏里读到
// ============================================================================
// 为什么值得单独测：媒体键（静音、音量、播放/暂停…）走的是 HID 的
// **Consumer Control 用法页（0x0C）**，和普通按键（键盘用法页 0x06）不是同一路。
// 反作弊很可能只挂钩了标准键盘那一路，所以媒体键可能在游戏里仍可读。
//
// 本探针同时用四条互不相同的路径读媒体键，一次测完看哪条通：
//
//   1. RegisterHotKey —— 向系统注册全局热键。模态无关（不要求本进程前台），
//      游戏占用焦点时系统仍会把 WM_HOTKEY 投给注册者。这是最有希望的一条。
//
//   2. 低级键盘钩子 —— 媒体键也会以 VK 0xAD~0xAF 等形式经过钩子链。
//      已知普通按键在游戏里读不到，媒体键如何要看实测。
//
//   3. GetAsyncKeyState 轮询 —— 不走钩子链，直接查状态表。
//
//   4. Raw Input（Consumer Control 用法页 0x01/0x0C）—— 直接读该用法页的
//      原始报告。如果反作弊没挂这一路，/这里能看到。
//
// 只读，不注入、不模拟输入。
//
// 用法：
//   media-probe.exe                四条路径全测
//   media-probe.exe --hotkey-only  只测 RegisterHotKey
// ============================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class MediaProbe
{
    // --- 媒体键虚拟键码 -----------------------------------------------------
    private const int VK_VOLUME_MUTE = 0xAD;
    private const int VK_VOLUME_DOWN = 0xAE;
    private const int VK_VOLUME_UP = 0xAF;
    private const int VK_MEDIA_NEXT_TRACK = 0xB0;
    private const int VK_MEDIA_PREV_TRACK = 0xB1;
    private const int VK_MEDIA_STOP = 0xB2;
    private const int VK_MEDIA_PLAY_PAUSE = 0xB3;

    private static readonly Dictionary<int, string> MediaNames = new Dictionary<int, string>
    {
        { VK_VOLUME_MUTE, "静音" },
        { VK_VOLUME_DOWN, "音量-" },
        { VK_VOLUME_UP, "音量+" },
        { VK_MEDIA_NEXT_TRACK, "下一曲" },
        { VK_MEDIA_PREV_TRACK, "上一曲" },
        { VK_MEDIA_STOP, "停止" },
        { VK_MEDIA_PLAY_PAUSE, "播放/暂停" }
    };

    private static readonly int[] MediaKeys = new int[]
    {
        VK_VOLUME_MUTE, VK_VOLUME_DOWN, VK_VOLUME_UP,
        VK_MEDIA_PREV_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_NEXT_TRACK, VK_MEDIA_STOP
    };

    // --- RegisterHotKey -----------------------------------------------------
    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_NOREPEAT = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    // --- 低级键盘钩子 -------------------------------------------------------
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

    // --- GetAsyncKeyState ---------------------------------------------------
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    // --- Raw Input（Consumer Control）---------------------------------------
    private const int WM_INPUT = 0x00FF;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIDI_DEVICENAME = 0x20000007;
    private const uint RIDEV_INPUTSINK = 0x00000100;
    private const uint RIM_TYPEHID = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICE
    {
        public ushort usUsagePage;
        public ushort usUsage;
        public uint dwFlags;
        public IntPtr hwndTarget;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTHEADER
    {
        public uint dwType;
        public uint dwSize;
        public IntPtr hDevice;
        public IntPtr wParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWHID
    {
        public uint dwSizeHid;
        public uint dwCount;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll")]
    private static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, IntPtr data, ref uint size);

    // --- 前台窗口 -----------------------------------------------------------
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private static volatile bool _running = true;
    private static long _hotkeyHits;
    private static long _hookHits;
    private static long _pollHits;
    private static long _rawHits;
    private static string _lastForeground = "";

    private sealed class Window : Form
    {
        private readonly LowLevelKeyboardProc _proc;
        private IntPtr _hook = IntPtr.Zero;
        private readonly List<int> _registered = new List<int>();
        private readonly bool _hotkeyOnly;

        public Window(bool hotkeyOnly)
        {
            _hotkeyOnly = hotkeyOnly;
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
            _proc = OnKeyboardHook;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);

            // 路径 1：RegisterHotKey。媒体键通常可以直接注册（不像普通键会被
            // 已占用），而且它不要求本进程前台 —— 这正是"游戏占着焦点"时要的。
            Console.WriteLine("== 路径 1：RegisterHotKey（最有希望的一条）==");
            int id = 1;
            foreach (int vk in MediaKeys)
            {
                string name = MediaNames[vk];
                if (RegisterHotKey(Handle, id, MOD_NOREPEAT, (uint)vk))
                {
                    _registered.Add(id);
                    Console.WriteLine("  注册成功: " + name + " (VK 0x" + vk.ToString("X2") + ")");
                }
                else
                {
                    Console.WriteLine("  注册失败: " + name +
                        " (VK 0x" + vk.ToString("X2") + ")  错误码 " + Marshal.GetLastWin32Error());
                }
                id++;
            }

            if (_hotkeyOnly) return;

            // 路径 2：低级键盘钩子
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
            Console.WriteLine();
            Console.WriteLine("== 路径 2：低级键盘钩子 ==");
            Console.WriteLine("  " + (_hook != IntPtr.Zero ? "已安装" : "安装失败"));

            // 路径 4：Raw Input —— 明确订阅 Consumer Control（0x01/0x0C）
            var devices = new RAWINPUTDEVICE[]
            {
                new RAWINPUTDEVICE { usUsagePage = 0x0C, usUsage = 0x01, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle }
            };
            bool raw = RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
            Console.WriteLine();
            Console.WriteLine("== 路径 4：Raw Input（Consumer Control 用法页 0x0C）==");
            Console.WriteLine("  " + (raw ? "注册成功" : "注册失败，错误码 " + Marshal.GetLastWin32Error()));

            Console.WriteLine();
            Console.WriteLine("== 路径 3：GetAsyncKeyState 轮询（后台线程）==");
            Console.WriteLine("  已启动");

            var poll = new Thread(PollLoop) { IsBackground = true };
            poll.Start();

            Console.WriteLine();
            Console.WriteLine(new string('-', 78));
            Console.WriteLine("测试步骤：");
            Console.WriteLine("  1. 先在终端里按媒体键（静音/音量/播放），确认至少有一条路径有反应");
            Console.WriteLine("  2. 切进 CFHD，按同样的键几次");
            Console.WriteLine("  3. 切回来按 Ctrl+C 看汇总");
            Console.WriteLine();
            Console.WriteLine("每条命中都会标出**按键时前台是哪个窗口**，那是判断能否穿透的依据。");
            Console.Out.Flush();
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                int index = _registered.IndexOf(id);
                if (index >= 0)
                {
                    _hotkeyHits++;
                    Report("[热键] " + MediaNames[MediaKeys[index]]);
                }
            }
            else if (m.Msg == WM_INPUT)
            {
                OnRawInput(m.LParam);
            }
            base.WndProc(ref m);
        }

        private void OnRawInput(IntPtr hRawInput)
        {
            uint size = 0;
            uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
            GetRawInputData(hRawInput, RID_INPUT, IntPtr.Zero, ref size, headerSize);
            if (size == 0) return;

            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                if (GetRawInputData(hRawInput, RID_INPUT, buffer, ref size, headerSize) != size) return;
                var header = (RAWINPUTHEADER)Marshal.PtrToStructure(buffer, typeof(RAWINPUTHEADER));
                if (header.dwType != RIM_TYPEHID) return;

                IntPtr body = new IntPtr(buffer.ToInt64() + headerSize);
                var hid = (RAWHID)Marshal.PtrToStructure(body, typeof(RAWHID));
                int length = (int)(hid.dwSizeHid * hid.dwCount);
                if (length <= 0 || length > 64) return;

                var bytes = new byte[length];
                Marshal.Copy(new IntPtr(body.ToInt64() + Marshal.SizeOf(typeof(RAWHID))), bytes, 0, length);
                var sb = new StringBuilder();
                foreach (byte b in bytes) sb.Append(b.ToString("X2")).Append(' ');

                _rawHits++;
                Report("[RawInput 0x0C] 报告: " + sb.ToString().Trim());
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private IntPtr OnKeyboardHook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int message = wParam.ToInt32();
                if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
                {
                    var data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    string name;
                    if (MediaNames.TryGetValue((int)data.vkCode, out name))
                    {
                        _hookHits++;
                        Report("[钩子] " + name + " (VK 0x" + data.vkCode.ToString("X2") + ")");
                    }
                }
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        public void Cleanup()
        {
            foreach (int id in _registered) UnregisterHotKey(Handle, id);
            if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
        }

        [DllImport("user32.dll")]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        private static void PollLoop()
        {
            var wasDown = new Dictionary<int, bool>();
            while (_running)
            {
                foreach (int vk in MediaKeys)
                {
                    bool down = (GetAsyncKeyState(vk) & 0x8000) != 0;
                    bool previously;
                    wasDown.TryGetValue(vk, out previously);
                    if (down && !previously)
                    {
                        _pollHits++;
                        Report("[轮询] " + MediaNames[vk]);
                    }
                    wasDown[vk] = down;
                }
                Thread.Sleep(10);
            }
        }
    }

    private static void Report(string message)
    {
        string foreground = ForegroundDescription();
        lock (typeof(MediaProbe))
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

    private static void PrintSummary()
    {
        Console.WriteLine();
        Console.WriteLine(new string('-', 78));
        Console.WriteLine("汇总（按命中数）：");
        Console.WriteLine("  RegisterHotKey  : " + _hotkeyHits);
        Console.WriteLine("  低级键盘钩子    : " + _hookHits);
        Console.WriteLine("  GetAsyncKeyState: " + _pollHits);
        Console.WriteLine("  RawInput 0x0C   : " + _rawHits);
        Console.WriteLine();
        Console.WriteLine("判读：关键在于**游戏占用焦点时**哪一项还在增长。");
        Console.WriteLine("只要有一项在游戏里也有命中，媒体键就能当触发器。");
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        bool hotkeyOnly = Array.IndexOf(args, "--hotkey-only") >= 0;

        Console.WriteLine("== 媒体键探针 ==");
        Console.WriteLine("进程位数: " + (Environment.Is64BitProcess ? "64 位" : "32 位"));
        Console.WriteLine();

        // --hotkey-only 只测 RegisterHotKey；默认四条路径全测。
        // 注意这里传的是「是否只测热键」，别把条件写反 —— 写反会导致默认模式什么都不做。
        var window = new Window(hotkeyOnly);
        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e)
        {
            e.Cancel = true;
            _running = false;
            window.Cleanup();
            PrintSummary();
            Environment.Exit(0);
        };
        Application.EnableVisualStyles();
        Application.Run(window);
    }
}
