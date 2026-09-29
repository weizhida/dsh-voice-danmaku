// ============================================================================
// 输入设备枚举 + 按键来源定位
// ============================================================================
// 目的：回答一个决定性问题 —— **某个键是哪个 HID 设备发出来的**。
//
// 为什么这件事决定方案：Windows 的 Raw Input 支持按设备路径过滤。如果小键盘
// 是独立设备，我们就能"只听那个设备"，游戏读不到它，于是键就能穿过游戏；
// 如果小键盘和主键盘是同一个设备，就没有可过滤的边界，方案不成立。
//
// 它做两件事：
//   1. 列出系统里所有键盘/鼠标类 HID 设备（供你认哪个是小键盘）；
//   2. 进入监听：你按一个键，它就报出**这个键来自哪个设备**。
//
// 只读不拦。
// ============================================================================

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class DeviceProbe
{
    private const int WM_INPUT = 0x00FF;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIDI_DEVICENAME = 0x20000007;
    private const uint RIDI_DEVICEINFO = 0x2000000b;
    private const uint RIDEV_INPUTSINK = 0x00000100;
    private const uint RIM_TYPEKEYBOARD = 1;
    private const uint RIM_TYPEMOUSE = 0;

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
    private struct RID_DEVICE_INFO
    {
        public uint cbSize;
        public uint dwType;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RID_DEVICE_INFO_KEYBOARD
    {
        public uint dwType;
        public uint dwSubType;
        public uint dwKeyboardMode;
        public uint dwNumberOfFunctionKeys;
        public uint dwNumberOfIndicators;
        public uint dwNumberOfKeysTotal;
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

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICELIST
    {
        public IntPtr hDevice;
        public uint dwType;
    }

    private sealed class Window : Form
    {
        public Window()
        {
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);

            PrintDeviceList();

            var devices = new RAWINPUTDEVICE[]
            {
                new RAWINPUTDEVICE { usUsagePage = 0x01, usUsage = 0x06, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle },
                new RAWINPUTDEVICE { usUsagePage = 0x01, usUsage = 0x02, dwFlags = RIDEV_INPUTSINK, hwndTarget = Handle }
            };
            bool ok = RegisterRawInputDevices(devices, (uint)devices.Length, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
            Console.WriteLine();
            Console.WriteLine("Raw Input 注册: " + (ok ? "成功" : "失败 " + Marshal.GetLastWin32Error()));
            Console.WriteLine();
            Console.WriteLine("== 现在按键，看它来自哪个设备 ==");
            Console.WriteLine("请依次按：主键盘的数字区、小键盘的数字、小键盘的 +/Enter");
            Console.WriteLine("这样就能看出小键盘是不是独立设备。Ctrl+C 结束。");
            Console.WriteLine(new string('-', 70));
            Console.Out.Flush();
        }

        /// <summary>列出所有键盘类设备。小键盘若独立，会在列表里单独出现。</summary>
        private static void PrintDeviceList()
        {
            uint count = 0;
            uint size = (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICELIST));
            GetRawInputDeviceList(IntPtr.Zero, ref count, size);
            if (count == 0) return;

            IntPtr buffer = Marshal.AllocHGlobal((int)(count * size));
            try
            {
                if (GetRawInputDeviceList(buffer, ref count, size) == uint.MaxValue) return;
                Console.WriteLine("== 系统输入设备列表（共 " + count + " 个）==");
                for (int i = 0; i < count; i++)
                {
                    IntPtr item = new IntPtr(buffer.ToInt64() + i * (long)size);
                    var entry = (RAWINPUTDEVICELIST)Marshal.PtrToStructure(item, typeof(RAWINPUTDEVICELIST));
                    if (entry.dwType != RIM_TYPEKEYBOARD) continue;

                    string name = DeviceName(entry.hDevice);
                    string info = KeyboardInfo(entry.hDevice);
                    Console.WriteLine("  [键盘] " + Shorten(name));
                    if (info.Length > 0) Console.WriteLine("         " + info);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static string DeviceName(IntPtr hDevice)
        {
            uint size = 0;
            GetRawInputDeviceInfo(hDevice, RIDI_DEVICENAME, IntPtr.Zero, ref size);
            if (size == 0) return "(未知)";
            var sb = new StringBuilder((int)size + 1);
            if (GetRawInputDeviceInfo(hDevice, RIDI_DEVICENAME, sb, ref size) == 0) return "(未知)";
            return sb.ToString();
        }

        private static string KeyboardInfo(IntPtr hDevice)
        {
            var info = new RID_DEVICE_INFO_KEYBOARD();
            uint size = (uint)Marshal.SizeOf(typeof(RID_DEVICE_INFO_KEYBOARD));
            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                // cbSize 必须是整个结构的大小，否则调用失败
                Marshal.WriteInt32(buffer, 0, (int)Marshal.SizeOf(typeof(RID_DEVICE_INFO)));
                Marshal.WriteInt32(buffer, 4, (int)RIM_TYPEKEYBOARD);
                if (GetRawInputDeviceInfo(hDevice, RIDI_DEVICEINFO, buffer, ref size) == uint.MaxValue) return "";
                info = (RID_DEVICE_INFO_KEYBOARD)Marshal.PtrToStructure(buffer, typeof(RID_DEVICE_INFO_KEYBOARD));
                return "按键总数=" + info.dwNumberOfKeysTotal +
                       " 功能键=" + info.dwNumberOfFunctionKeys +
                       " 指示灯=" + info.dwNumberOfIndicators;
            }
            catch
            {
                return "";
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static string Shorten(string name)
        {
            // \\?\HID#VID_046D&PID_C31C#...  -> 保留 VID/PID 与结尾，中间省略
            if (name.Length <= 70) return name;
            int vid = name.IndexOf("VID_", StringComparison.OrdinalIgnoreCase);
            string head = vid >= 0 ? name.Substring(vid, Math.Min(17, name.Length - vid)) : name.Substring(0, 20);
            return head + " … " + name.Substring(name.Length - 20);
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

                if (header.dwType == RIM_TYPEKEYBOARD)
                {
                    var kb = (RAWKEYBOARD)Marshal.PtrToStructure(body, typeof(RAWKEYBOARD));
                    bool down = (kb.Flags & 0x01) == 0;   // RI_KEY_BREAK = 0x01
                    if (!down) return;
                    Console.WriteLine("VKey=0x" + kb.VKey.ToString("X2") +
                        " MakeCode=0x" + kb.MakeCode.ToString("X2") +
                        "  来自: " + Shorten(DeviceName(header.hDevice)));
                    Console.Out.Flush();
                }
                else if (header.dwType == RIM_TYPEMOUSE)
                {
                    var mouse = (RAWMOUSE)Marshal.PtrToStructure(body, typeof(RAWMOUSE));
                    if (mouse.usButtonFlags == 0) return;
                    Console.WriteLine("[鼠标] flags=0x" + mouse.usButtonFlags.ToString("X4") +
                        " raw=0x" + mouse.ulRawButtons.ToString("X8") +
                        "  来自: " + Shorten(DeviceName(header.hDevice)));
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
    private static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine("== 输入设备枚举与来源定位 ==");
        Application.EnableVisualStyles();
        Application.Run(new Window());
    }
}
