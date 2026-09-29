// ============================================================================
// Raw Input 穿透验证 —— 游戏占用焦点时，我们还能不能读到按键
// ============================================================================
// 要验证的问题：一边是游戏屏蔽了低级键盘钩子，另一边是我们用 Raw Input
// （按设备路径过滤）能不能照常读到按键。
//
// 为什么这个验证值得做：如果 Raw Input 也读不到，那"换设备/换过滤方式"这条路
// 就不成立，应该改用完全不经过游戏输入栈的方案（例如手机触发）。花十分钟
// 验证，比先埋头实现再发现不行划算得多。
//
// 做法：注册键盘 Raw Input（RIDEV_INPUTSINK 让它在非前台时也收），每收到一个
// 按键就打印：
//   * 虚拟键码与扫描码
//   * 该按键来自哪个设备（VID/PID + 完整路径）
//   * **按键时前台窗口是什么**（进程名 + 标题）← 这是判断"游戏里能否读到"的关键
//
// 只读不拦，不影响正常使用。
//
// 用法：
//   rawinput-probe.exe              监听全部键盘（默认）
//   rawinput-probe.exe --vid C232   只看某个设备（按 VID/PID 过滤）
//   rawinput-probe.exe --no-filter  同默认
// ============================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class RawInputProbe
{
    private const int WM_INPUT = 0x00FF;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIDI_DEVICENAME = 0x20000007;
    private const uint RIDEV_INPUTSINK = 0x00000100;
    private const uint RIM_TYPEKEYBOARD = 1;

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
    private struct RAWKEYBOARD
    {
        public ushort MakeCode;
        public ushort Flags;
        public ushort Reserved;
        public ushort VKey;
        public uint Message;
        public uint ExtraInformation;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll")]
    private static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, StringBuilder data, ref uint size);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, IntPtr data, ref uint size);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private static readonly Dictionary<IntPtr, string> Names = new Dictionary<IntPtr, string>();
    private static string _filter = "";

    private sealed class Window : Form
    {
        private long _total;
        private string _lastForeground = "";

        public Window()
        {
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);

            var devices = new RAWINPUTDEVICE[]
            {
                // 0x01/0x06 = 通用桌面 / 键盘。RIDEV_INPUTSINK 让本窗口在
                // **非前台**时也收得到输入 —— 这正是"游戏占着焦点"时的场景。
                new RAWINPUTDEVICE { usUsagePage = 0x01, usUsage = 0x06, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle }
            };
            bool ok = RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));

            Console.WriteLine("键盘 Raw Input 注册: " + (ok ? "成功" : "失败，错误码 " + Marshal.GetLastWin32Error()));
            if (_filter.Length > 0) Console.WriteLine("设备过滤: 只显示含「" + _filter + "」的设备");
            Console.WriteLine();
            Console.WriteLine("== 先在外面按几个键确认能看到，再切进游戏按 ==");
            Console.WriteLine("每行都会标出**按键时前台是哪个窗口**，那是判断能否穿透的依据。");
            Console.WriteLine("Ctrl+C 结束（结束时打印统计）。");
            Console.WriteLine(new string('-', 78));
            Console.Out.Flush();
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_INPUT) OnRawInput(m.LParam);
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
                if (header.dwType != RIM_TYPEKEYBOARD) return;

                IntPtr body = new IntPtr(buffer.ToInt64() + headerSize);
                var kb = (RAWKEYBOARD)Marshal.PtrToStructure(body, typeof(RAWKEYBOARD));
                if ((kb.Flags & 0x01) != 0) return;   // RI_KEY_BREAK：只报按下

                string devicePath = DevicePath(header.hDevice);
                if (_filter.Length > 0 &&
                    devicePath.IndexOf(_filter, StringComparison.OrdinalIgnoreCase) < 0) return;

                _total++;
                string foreground = ForegroundDescription();
                // 粗略判断"是否在游戏里"：前台窗口不是控制台/资源管理器这类。
                // 这里不猜进程名，只记录，由看日志的人（或我）判断。
                if (foreground != _lastForeground)
                {
                    _lastForeground = foreground;
                    Console.WriteLine();
                    Console.WriteLine("--- 前台窗口切到: " + foreground + " ---");
                }

                Console.WriteLine(string.Format(
                    "VKey=0x{0:X2} Scan=0x{1:X2}  设备={2}",
                    kb.VKey, kb.MakeCode, ShortId(devicePath)));
                Console.Out.Flush();
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void PrintSummary()
        {
            Console.WriteLine();
            Console.WriteLine(new string('-', 78));
            Console.WriteLine("共收到 " + _total + " 次键盘按下事件。");
            Console.WriteLine(_total > 0
                ? "结论：Raw Input 监听是工作的（问题只在于游戏里那几次是否也收到了）。"
                : "结论：一次都没收到 —— 说明这个环境里 Raw Input 也不可用，方案不成立。");
        }

        private static string DevicePath(IntPtr hDevice)
        {
            string cached;
            if (Names.TryGetValue(hDevice, out cached)) return cached;

            uint size = 0;
            GetRawInputDeviceInfo(hDevice, RIDI_DEVICENAME, IntPtr.Zero, ref size);
            string name = "(未知)";
            if (size > 0)
            {
                var sb = new StringBuilder((int)size + 1);
                if (GetRawInputDeviceInfo(hDevice, RIDI_DEVICENAME, sb, ref size) > 0) name = sb.ToString();
            }
            Names[hDevice] = name;
            return name;
        }

        /// <summary>把设备路径缩成 VID/PID/接口，便于一眼分辨是哪个设备。</summary>
        private static string ShortId(string path)
        {
            var vid = System.Text.RegularExpressions.Regex.Match(path, @"VID_([0-9A-Fa-f]{4})");
            var pid = System.Text.RegularExpressions.Regex.Match(path, @"PID_([0-9A-Fa-f]{4})");
            var mi = System.Text.RegularExpressions.Regex.Match(path, @"MI_([0-9A-Fa-f]{2})");
            return "VID_" + (vid.Success ? vid.Groups[1].Value : "?") +
                   " PID_" + (pid.Success ? pid.Groups[1].Value : "?") +
                   (mi.Success ? " MI_" + mi.Groups[1].Value : "");
        }

        /// <summary>当前前台窗口的"进程名 | 标题"，用来判断按键发生在哪个程序里。</summary>
        private static string ForegroundDescription()
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return "(无前台窗口)";

            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string process = "?";
            try { process = Process.GetProcessById((int)pid).ProcessName; }
            catch { }

            var title = new StringBuilder(256);
            GetWindowText(hwnd, title, title.Capacity);
            string text = title.ToString();
            if (text.Length > 40) text = text.Substring(0, 40) + "…";
            return process + (text.Length > 0 ? " | " + text : "");
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--vid" && i + 1 < args.Length) _filter = args[i + 1];
            if (args[i] == "--filter" && i + 1 < args.Length) _filter = args[i + 1];
        }

        Console.WriteLine("== Raw Input 穿透验证 ==");
        Console.WriteLine("进程位数: " + (Environment.Is64BitProcess ? "64 位" : "32 位"));
        Console.WriteLine();

        var window = new Window();
        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e)
        {
            e.Cancel = true;   // 自己收尾，好把统计打出来
            window.PrintSummary();
            Environment.Exit(0);
        };

        Application.EnableVisualStyles();
        Application.Run(window);
    }
}
