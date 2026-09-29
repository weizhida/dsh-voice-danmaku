// ============================================================================
// 输入设备探针 —— 看清按键的真实信号与来源设备
// ============================================================================
// 背景：游戏会吃掉某些输入，而罗技 G HUB 这类软件还会接管可编程键。要选对
// 监听方式，必须先知道一个键**发出什么信号、来自哪个设备**：
//
//   * 标准鼠标按钮           → WH_MOUSE_LL 钩子能看到；
//   * 超出 5 键的鼠标按钮     → 只能从 Raw Input 的 ulRawButtons 看到；
//   * 厂商私有 HID 报告       → 只能从 Raw Input 的 HID 报告看到；
//   * 被 G HUB 吞掉           → 任何方式都看不到（换键或改 G HUB 绑定）；
//   * 独立 HID 键盘设备       → 可按设备路径过滤，游戏读不到 → 能穿过游戏。
//
// 最后一条是"独立小键盘能不能用"的判据：如果小键盘有自己的设备路径，
// 我们就能只听它；如果它和主键盘是同一个设备，就没有可过滤的边界。
//
// 本探针只读不拦：钩子一律 CallNextHookEx，不影响正常使用。
//
// 用法（由 tools/probe-input.ps1 调用）：
//   input-probe.exe --list     只列出输入设备，不监听
//   input-probe.exe            列出设备后进入监听（默认）
// ============================================================================

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class InputProbe
{
    // --- 低级鼠标钩子（看标准鼠标按钮）-------------------------------------
    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_XBUTTONDOWN = 0x020B;

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public int ptX;
        public int ptY;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    // --- Raw Input ----------------------------------------------------------
    private const int WM_INPUT = 0x00FF;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIDI_DEVICENAME = 0x20000007;
    private const uint RIDI_DEVICEINFO = 0x2000000b;
    private const uint RIDEV_INPUTSINK = 0x00000100;
    private const uint RIM_TYPEMOUSE = 0;
    private const uint RIM_TYPEKEYBOARD = 1;
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
    private struct RAWINPUTDEVICELIST
    {
        public IntPtr hDevice;
        public uint dwType;
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
    private struct RAWMOUSE
    {
        public ushort usFlags;
        public ushort usButtonFlags;
        public ushort usButtonData;
        public uint ulRawButtons;
        public int lLastX;
        public int lLastY;
        public uint ulExtraInformation;
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

    [DllImport("user32.dll")]
    private static extern uint GetRawInputDeviceList(IntPtr devices, ref uint count, uint size);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, StringBuilder data, ref uint size);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, IntPtr data, ref uint size);

    // 设备句柄 → 可读名字的缓存（同一设备只查一次）
    private static readonly Dictionary<IntPtr, string> DeviceNames = new Dictionary<IntPtr, string>();
    // 设备句柄 → 稳定标识（去掉结尾的实例路径），用于判断"是不是同一个设备"
    private static readonly Dictionary<IntPtr, string> DeviceKeys = new Dictionary<IntPtr, string>();

    private sealed class Window : Form
    {
        private readonly LowLevelMouseProc _mouseProc;
        private IntPtr _mouseHook = IntPtr.Zero;
        private readonly bool _watch;

        public Window(bool watch)
        {
            _watch = watch;
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
            _mouseProc = OnMouseHook;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);

            PrintDeviceList();

            if (!_watch)
            {
                // 不能在这里直接 Close()：此刻句柄仍在创建过程中，Form.Close() 会抛
                // `执行 CreateHandle() 时无法调用值 Close()`（真实踩到过）。
                // 把关闭排到消息队列里，等本次创建流程走完再执行。
                BeginInvoke(new Action(Close));
                return;
            }

            // 低级鼠标钩子：看标准鼠标按钮（含 XBUTTON1/2）
            _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, GetModuleHandle(null), 0);

            // Raw Input：看 HID 原始报告与按键的设备来源。
            // RIDEV_INPUTSINK 是关键 —— 它让本窗口**非前台**时也能收到输入，
            // 否则切到别的窗口就什么都看不到了。
            var devices = new RAWINPUTDEVICE[]
            {
                new RAWINPUTDEVICE { usUsagePage = 0x01, usUsage = 0x06, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle }, // 键盘
                new RAWINPUTDEVICE { usUsagePage = 0x01, usUsage = 0x02, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle }, // 鼠标
                new RAWINPUTDEVICE { usUsagePage = 0x01, usUsage = 0x08, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle }, // 多轴控制器
                new RAWINPUTDEVICE { usUsagePage = 0x01, usUsage = 0x80, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle }  // 系统控制
            };
            bool registered = RegisterRawInputDevices(
                devices, (uint)devices.Length, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));

            Console.WriteLine();
            Console.WriteLine("低级鼠标钩子: " + (_mouseHook != IntPtr.Zero ? "已安装" : "安装失败"));
            Console.WriteLine("Raw Input 注册: " + (registered
                ? "成功"
                : "失败，错误码 " + Marshal.GetLastWin32Error()));
            Console.WriteLine();
            Console.WriteLine("== 现在按键，看它来自哪个设备 ==");
            Console.WriteLine(new string('-', 70));
            Console.Out.Flush();
        }

        private static void PrintDeviceList()
        {
            uint count = 0;
            uint size = (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICELIST));
            GetRawInputDeviceList(IntPtr.Zero, ref count, size);
            if (count == 0)
            {
                Console.WriteLine("（取不到设备列表）");
                return;
            }

            IntPtr buffer = Marshal.AllocHGlobal((int)(count * size));
            try
            {
                if (GetRawInputDeviceList(buffer, ref count, size) == uint.MaxValue) return;

                var keyboards = new List<string>();
                var mice = new List<string>();
                for (int i = 0; i < count; i++)
                {
                    IntPtr item = new IntPtr(buffer.ToInt64() + i * (long)size);
                    var entry = (RAWINPUTDEVICELIST)Marshal.PtrToStructure(item, typeof(RAWINPUTDEVICELIST));
                    string name = DeviceName(entry.hDevice);
                    if (entry.dwType == RIM_TYPEKEYBOARD) keyboards.Add(name);
                    else if (entry.dwType == RIM_TYPEMOUSE) mice.Add(name);
                }

                Console.WriteLine("== 键盘类设备（" + keyboards.Count + " 个）==");
                if (keyboards.Count == 0) Console.WriteLine("  （无）");
                foreach (string k in keyboards)
                {
                    Console.WriteLine("  VID/PID: " + HardwareId(k));
                    Console.WriteLine("  完整路径: " + k);
                }

                Console.WriteLine();
                Console.WriteLine("== 鼠标类设备（" + mice.Count + " 个）==");
                foreach (string m in mice)
                {
                    Console.WriteLine("  VID/PID: " + HardwareId(m));
                    Console.WriteLine("  完整路径: " + m);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static string DeviceName(IntPtr hDevice)
        {
            string cached;
            if (DeviceNames.TryGetValue(hDevice, out cached)) return cached;

            uint size = 0;
            GetRawInputDeviceInfo(hDevice, RIDI_DEVICENAME, IntPtr.Zero, ref size);
            string name = "(未知)";
            if (size > 0)
            {
                var sb = new StringBuilder((int)size + 1);
                if (GetRawInputDeviceInfo(hDevice, RIDI_DEVICENAME, sb, ref size) > 0) name = sb.ToString();
            }
            DeviceNames[hDevice] = name;

            // 稳定标识：去掉末尾的实例段（&0000 之类），同型号的不同接口会不同。
            string key = name;
            int lastHash = name.LastIndexOf('#');
            if (lastHash > 0) key = name.Substring(0, lastHash);
            DeviceKeys[hDevice] = key;

            return name;
        }

        /// <summary>判断这个设备句柄是不是新出现的（用来给设备编号）。</summary>
        private static readonly Dictionary<string, int> DeviceIndexes = new Dictionary<string, int>();

        private static int DeviceIndexOf(IntPtr hDevice)
        {
            DeviceName(hDevice);
            string key = DeviceKeys[hDevice];
            int index;
            if (!DeviceIndexes.TryGetValue(key, out index))
            {
                index = DeviceIndexes.Count + 1;
                DeviceIndexes[key] = index;
            }
            return index;
        }

        /// <summary>
        /// 从设备路径里取出 VID/PID。用正则而不是手工拆字符串 —— 我手工拆了两次
        /// 都写错了（反斜杠转义、& 分段），正则没有这些坑。
        /// </summary>
        private static string HardwareId(string path)
        {
            var vid = System.Text.RegularExpressions.Regex.Match(path, @"VID_([0-9A-Fa-f]{4})");
            var pid = System.Text.RegularExpressions.Regex.Match(path, @"PID_([0-9A-Fa-f]{4})");
            var mi = System.Text.RegularExpressions.Regex.Match(path, @"MI_([0-9A-Fa-f]{2})");
            var col = System.Text.RegularExpressions.Regex.Match(path, @"Col([0-9A-Fa-f]{2})");
            return "VID_" + (vid.Success ? vid.Groups[1].Value : "?") +
                   " PID_" + (pid.Success ? pid.Groups[1].Value : "?") +
                   (mi.Success ? " MI_" + mi.Groups[1].Value : "") +
                   (col.Success ? " Col" + col.Groups[1].Value : "");
        }

        private static string Summarize(string full)
        {
            return HardwareId(full);
        }

        public void CloseProbe()
        {
            if (_mouseHook != IntPtr.Zero) UnhookWindowsHookEx(_mouseHook);
            Close();
        }

        [DllImport("user32.dll")]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        private IntPtr OnMouseHook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int message = wParam.ToInt32();
                if (message == WM_XBUTTONDOWN)
                {
                    var data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    int xbutton = (int)(data.mouseData >> 16);
                    Console.WriteLine("[鼠标钩子] XBUTTON" + xbutton +
                        "  mouseData=0x" + data.mouseData.ToString("X8"));
                    Console.Out.Flush();
                }
                else if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN)
                {
                    string which = message == WM_LBUTTONDOWN ? "左键" : (message == WM_RBUTTONDOWN ? "右键" : "中键");
                    Console.WriteLine("[鼠标钩子] " + which);
                    Console.Out.Flush();
                }
            }
            return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
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
                IntPtr body = new IntPtr(buffer.ToInt64() + headerSize);
                int index = DeviceIndexOf(header.hDevice);

                if (header.dwType == RIM_TYPEKEYBOARD)
                {
                    var kb = (RAWKEYBOARD)Marshal.PtrToStructure(body, typeof(RAWKEYBOARD));
                    if ((kb.Flags & 0x01) != 0) return;   // 只报按下
                    Console.WriteLine("[键盘] VKey=0x" + kb.VKey.ToString("X2") +
                        " ScanCode=0x" + kb.MakeCode.ToString("X2") +
                        "  ← 设备 #" + index);
                    Console.Out.Flush();
                }
                else if (header.dwType == RIM_TYPEMOUSE)
                {
                    var mouse = (RAWMOUSE)Marshal.PtrToStructure(body, typeof(RAWMOUSE));
                    if (mouse.usButtonFlags == 0) return;
                    Console.WriteLine("[RawInput 鼠标] flags=0x" + mouse.usButtonFlags.ToString("X4") +
                        " rawButtons=0x" + mouse.ulRawButtons.ToString("X8") +
                        "  ← 设备 #" + index);
                    Console.Out.Flush();
                }
                else if (header.dwType == RIM_TYPEHID)
                {
                    var hid = (RAWHID)Marshal.PtrToStructure(body, typeof(RAWHID));
                    int length = (int)(hid.dwSizeHid * hid.dwCount);
                    if (length <= 0 || length > 256) return;
                    var bytes = new byte[length];
                    Marshal.Copy(new IntPtr(body.ToInt64() + Marshal.SizeOf(typeof(RAWHID))), bytes, 0, length);
                    var sb = new StringBuilder();
                    foreach (byte b in bytes) sb.Append(b.ToString("X2")).Append(' ');
                    Console.WriteLine("[RawInput HID ] 报告: " + sb.ToString().Trim() + "  ← 设备 #" + index);
                    Console.Out.Flush();
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        bool listOnly = Array.IndexOf(args, "--list") >= 0;

        Console.WriteLine("== 输入设备枚举 ==");
        Console.WriteLine("进程位数: " + (Environment.Is64BitProcess ? "64 位" : "32 位"));
        Console.WriteLine();

        if (!listOnly)
        {
            Console.WriteLine("接下来请在**不同的按键来源**上各按几下，用来看清它们是不是同一个设备：");
            Console.WriteLine("  1. 主键盘的数字 1 2 3");
            Console.WriteLine("  2. 小键盘的数字 1 2 3（如果有）");
            Console.WriteLine("  3. 小键盘的 + 和 Enter");
            Console.WriteLine("  4. 鼠标左键（确认钩子在工作）");
            Console.WriteLine("  5. DPI 增加 / 减少（G10 / G11）");
            Console.WriteLine();
            Console.WriteLine("每个键后面会标出「设备 #N」，同一个 N 就是同一个设备。");
            Console.WriteLine("按 Ctrl+C 结束。只读不拦，不影响正常使用。");
            Console.WriteLine(new string('-', 70));
        }

        Application.EnableVisualStyles();
        Application.Run(new Window(!listOnly));
    }
}
