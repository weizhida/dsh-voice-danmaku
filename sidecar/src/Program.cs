// ============================================================================
// dsh-voice-danmaku —— Windows sidecar（第一步：全局热键 + 不抢焦点置顶浮层）
// ============================================================================
// 这个进程负责"只有 Windows 原生代码才能干的两件事"：
//   1. 全局低级键盘钩子（WH_KEYBOARD_LL）：游戏在前台时也能收到热键；
//   2. 一个置顶、不抢焦点的浮层窗口，用来在游戏上方显示待确认的文本。
//
// 它刻意不做别的：不认识 B 站、不认识 ASR、不认识 DSH。它只通过 stdio 上的
// JSON Lines 协议收发消息（见 docs/protocol.md），因此：
//   * 协议是唯一契约 —— 主程序（Node 插件）可以在不改这个进程的前提下演进业务；
//   * 换掉这个进程（比如以后用 koffi 直接调 Win32 省掉子进程）不影响业务层。
//
// 编译（零依赖、单文件，见 sidecar/build.mjs）：
//   csc.exe /target:winexe /platform:anycpu /out:sidecar/bin/dsh-voice-danmaku-sidecar.exe ...
//   /target:winexe 保证双击不弹控制台；stdio 仍然可用（我们显式取标准流句柄）。
//
// 代码风格约定：所有 UI 操作与钩子回调都在 UI 线程；stdin 读取在后台线程，
// 通过并发队列交给 UI 线程的定时器排空。任何跨线程直接操作控件都是 bug。
// ============================================================================

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshVoiceDanmaku
{
    // ========================================================================
    // JSON Lines 编解码
    // ========================================================================
    // 刻意不引入任何 JSON 库：消息是扁平的标量对象，一个几十行的写入器 +
    // 一个够用的解析器就够了，也让本进程保持"零第三方依赖"。
    internal static class Json
    {
        /// <summary>把标量字典写成一行 JSON。值为 null 时输出 JSON null。</summary>
        public static string Write(IDictionary<string, object> fields)
        {
            var sb = new StringBuilder(128);
            sb.Append('{');
            bool first = true;
            foreach (var kv in fields)
            {
                if (!first) sb.Append(',');
                first = false;
                AppendString(sb, kv.Key);
                sb.Append(':');
                AppendValue(sb, kv.Value);
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendValue(StringBuilder sb, object value)
        {
            if (value == null) { sb.Append("null"); return; }
            if (value is bool) { sb.Append(((bool)value) ? "true" : "false"); return; }
            if (value is int || value is long) { sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture)); return; }
            if (value is double || value is float)
            {
                sb.Append(Convert.ToDouble(value, CultureInfo.InvariantCulture)
                    .ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            AppendString(sb, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        private static void AppendString(StringBuilder sb, string text)
        {
            sb.Append('"');
            foreach (char c in text)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>
        /// 解析一个扁平 JSON 对象。只支持本协议用到的形态（对象 + 字符串/数字/
        /// 布尔/null 标量），不做嵌套与数组 —— 契约就这么大，多余的能力是负债。
        /// 解析失败返回空字典而不是抛异常：一条坏消息不该打死常驻进程。
        /// </summary>
        public static Dictionary<string, object> Parse(string line)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(line)) return result;

            int i = 0;
            SkipWhitespace(line, ref i);
            if (i >= line.Length || line[i] != '{') return result;
            i++;

            while (true)
            {
                SkipWhitespace(line, ref i);
                if (i >= line.Length) return result;
                if (line[i] == '}') return result;
                if (line[i] == ',') { i++; continue; }

                string key = ReadString(line, ref i);
                if (key == null) return result;

                SkipWhitespace(line, ref i);
                if (i >= line.Length || line[i] != ':') return result;
                i++;
                SkipWhitespace(line, ref i);

                object value = ReadValue(line, ref i);
                result[key] = value;

                SkipWhitespace(line, ref i);
                if (i >= line.Length) return result;
                if (line[i] == ',') { i++; continue; }
                if (line[i] == '}') return result;
                return result;
            }
        }

        private static void SkipWhitespace(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        private static string ReadString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') return null;
            i++;
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char esc = s[i++];
                switch (esc)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 <= s.Length)
                        {
                            int code;
                            if (int.TryParse(s.Substring(i, 4), NumberStyles.HexNumber,
                                    CultureInfo.InvariantCulture, out code))
                            {
                                sb.Append((char)code);
                                i += 4;
                            }
                        }
                        break;
                    default: sb.Append(esc); break;
                }
            }
            return sb.ToString();
        }

        private static object ReadValue(string s, ref int i)
        {
            if (i >= s.Length) return null;
            char c = s[i];
            if (c == '"') return ReadString(s, ref i);
            if (c == 't' && Matches(s, i, "true")) { i += 4; return true; }
            if (c == 'f' && Matches(s, i, "false")) { i += 5; return false; }
            if (c == 'n' && Matches(s, i, "null")) { i += 4; return null; }

            int start = i;
            while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '-' || s[i] == '+' ||
                                    s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++;
            if (i == start) { i++; return null; }

            string raw = s.Substring(start, i - start);
            long asLong;
            if (long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out asLong)) return asLong;
            double asDouble;
            if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out asDouble)) return asDouble;
            return raw;
        }

        private static bool Matches(string s, int i, string literal)
        {
            return i + literal.Length <= s.Length && string.CompareOrdinal(s, i, literal, 0, literal.Length) == 0;
        }

        /// <summary>从字典里取字符串；缺失或类型不符时返回回退值。</summary>
        public static string GetString(IDictionary<string, object> map, string key, string fallback)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value) || value == null) return fallback;
            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        /// <summary>从字典里取整数；缺失或类型不符时返回回退值。</summary>
        public static long GetLong(IDictionary<string, object> map, string key, long fallback)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        /// <summary>从字典里取布尔；接受 true/false 与 "true"/"false"。</summary>
        public static bool GetBool(IDictionary<string, object> map, string key, bool fallback)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value) || value == null) return fallback;
            if (value is bool) return (bool)value;
            string text = Convert.ToString(value, CultureInfo.InvariantCulture);
            if (string.Equals(text, "true", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(text, "false", StringComparison.OrdinalIgnoreCase)) return false;
            return fallback;
        }
    }

    // ========================================================================
    // Win32 互操作
    // ========================================================================
    internal static class Native
    {
        public const int WH_KEYBOARD_LL = 13;
        public const int WM_KEYDOWN = 0x0100;
        public const int WM_KEYUP = 0x0101;
        public const int WM_SYSKEYDOWN = 0x0104;
        public const int WM_SYSKEYUP = 0x0105;

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOPMOST = 0x00000008;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_LAYERED = 0x00080000;

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;
        public const uint SWP_NOZORDER = 0x0004;

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetProcessDPIAware();

        // --- 媒体键（RegisterHotKey）------------------------------------------
        //
        // 为什么媒体键要单独走这条路：实测 CFHD 的反作弊会拦掉低级键盘钩子
        // （普通按键在游戏里完全读不到），而**媒体键走的是 HID 的 Consumer Control
        // 用法页（0x0C）**，与键盘用法页（0x06）不是一路。而且 RegisterHotKey 由系统
        // 在把输入分发给前台窗口**之前**处理，因此它是最有可能穿透的一种机制。
        //
        // 代价：WM_HOTKEY 只在**按下**时投递，没有"抬起"事件。所以媒体键的交互只能
        // 是"按一下切换"，不能是"按住说话" —— 这条限制是本模块设计的出发点。
        //
        // 第一版为了拿到"按住多久"，额外用 20ms 定时器轮询 GetAsyncKeyState 来判断
        // 何时松开。**那个轮询已经被删掉**：上层从来只处理按下事件，而
        // GetAsyncKeyState 是键盘记录器的典型 API，这个工具没有任何理由轮询键盘状态。
        /// <summary>热键消息。wParam 是注册时给的 id。</summary>
        public const int WM_HOTKEY = 0x0312;
        /// <summary>不自动重复：按住时只投递一次 WM_HOTKEY，避免连发。</summary>
        public const uint MOD_NOREPEAT = 0x4000;

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    }

    // ========================================================================
    // 低频诊断日志（写文件，不写 stdout —— stdout 只跑协议）
    // ========================================================================
    internal static class Log
    {
        private static readonly object Gate = new object();
        private static string _path;

        public static void Initialize(string path)
        {
            _path = path;
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            }
            catch { }
        }

        public static void Line(string message)
        {
            if (string.IsNullOrEmpty(_path)) return;
            try
            {
                lock (Gate)
                {
                    File.AppendAllText(_path,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                        + " " + message + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { /* 日志失败绝不能影响主流程 */ }
        }
    }

    // ========================================================================
    // stdio 通道
    // ========================================================================
    /// <summary>
    /// 协议的唯一出入口。
    ///
    /// 这里刻意不走 Console.Out / Console.In：/target:winexe 的进程没有控制台，
    /// Console 的默认流在进程启动时就已经被缓存（可能无效），后面再 SetOut 不会
    /// 改变已经捕获了旧引用的代码路径。我们直接抓住标准句柄对应的流，让
    /// "写出去的东西到底去哪了"变成确定的。
    /// </summary>
    internal static class Protocol
    {
        private static readonly object Gate = new object();
        private static StreamWriter _writer;
        private static StreamReader _reader;

        /// <summary>打开标准流。必须在任何收发之前调用一次。</summary>
        public static bool Open()
        {
            try
            {
                _writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                _writer.AutoFlush = true;
                _reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                return true;
            }
            catch (Exception ex)
            {
                Log.Line("Protocol.Open failed: " + ex.Message);
                return false;
            }
        }

        /// <summary>读一行入站消息；stdin 关闭时返回 null。</summary>
        public static string ReadLine()
        {
            StreamReader reader = _reader;
            if (reader == null) return null;
            return reader.ReadLine();
        }

        /// <summary>写一行出站消息（含换行）并立即冲刷。写失败不抛，只记日志。</summary>
        public static void WriteLine(string line)
        {
            StreamWriter writer = _writer;
            if (writer == null) return;
            try
            {
                lock (Gate)
                {
                    writer.Write(line);
                    writer.Write('\n');
                    writer.Flush();
                }
            }
            catch (Exception ex)
            {
                Log.Line("Protocol.WriteLine failed: " + ex.Message);
            }
        }
    }

    // ========================================================================
    // 浮层窗口：置顶 + 不抢焦点 + 不接收鼠标
    // ========================================================================
    /// <summary>
    /// 显示待确认文本的浮层。
    ///
    /// 三条硬要求，任何一条破了这个功能就废了：
    ///   1. 必须在无边框全屏游戏之上 —— 靠 WS_EX_TOPMOST + 周期性重申；
    ///   2. 绝不能抢焦点 —— 靠 WS_EX_NOACTIVATE + ShowWithoutActivation 重写；
    ///      抢焦点会让游戏瞬间最小化，是最不可接受的失败模式；
    ///   3. 绝不能吃掉游戏鼠标 —— 靠 WS_EX_TRANSPARENT，点击穿透。
    /// </summary>
    internal sealed class OverlayForm : Form
    {
        private string _text = "";
        private string _accent = "#3B82F6";
        private string _hint = "";
        private int _fontSize = 26;
        private int _padding = 18;
        private int _marginTop = 0;
        private int _opacityPercent = 88;
        private double _anchorX = 0.5;
        private int _maxWidthPercent = 80;
        private bool _showHint = true;
        /// <summary>是否启用拖动浮层。关闭时浮层永远点击穿透。</summary>
        private bool _dragEnabled = false;
        /// <summary>当前是否点击穿透。</summary>
        private bool _clickThrough = true;
        private bool _dragging;
        private Point _dragOrigin;
        private Point _dragWindowOrigin;

        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.FromArgb(24, 24, 28);
            ForeColor = Color.White;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            // 允许拖动：按住浮层可以把它挪到不挡视线的地方，位置会回报给主程序。
            MouseDown += OnMouseDown;
            MouseMove += OnMouseMove;
            MouseUp += OnMouseUp;
        }

        /// <summary>禁止激活：浮层出现时焦点必须留在游戏上。</summary>
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Native.WS_EX_NOACTIVATE      // 不抢焦点
                            | Native.WS_EX_TOOLWINDOW      // 不出现在 Alt+Tab
                            | Native.WS_EX_LAYERED;        // 支持整体透明度
                // 点击穿透在 ApplyHitTestStyle 里按配置决定：拖动需要命中测试，
                // 而 WindowFromPoint 会跳过 WS_EX_TRANSPARENT 的窗口（影响遮挡自检）。
                if (_clickThrough) cp.ExStyle |= Native.WS_EX_TRANSPARENT;
                return cp;
            }
        }

        /// <summary>
        /// 按当前配置刷新命中测试样式：拖动期间必须能收鼠标；其余时候由
        /// clickThrough 配置决定。
        /// </summary>
        private void ApplyHitTestStyle()
        {
            bool transparent = _clickThrough && !_dragging;
            int ex = Native.GetWindowLong(Handle, Native.GWL_EXSTYLE);
            ex = transparent ? (ex | Native.WS_EX_TRANSPARENT) : (ex & ~Native.WS_EX_TRANSPARENT);
            Native.SetWindowLong(Handle, Native.GWL_EXSTYLE, ex);
        }

        /// <summary>浮层是否正在被拖动（拖动时需要临时接收鼠标事件）。</summary>
        public bool IsDragging { get { return _dragging; } }

        /// <summary>设置是否允许拖动浮层。</summary>
        public void SetDragEnabled(bool enabled)
        {
            _dragEnabled = enabled;
            ApplyHitTestStyle();
        }

        /// <summary>当前显示的文本，供状态查询回报。</summary>
        public string CurrentText { get { return _text; } }

        /// <summary>更新显示内容并重新布局。必须在 UI 线程调用。</summary>
        public void ApplyContent(string text, string accent, string hint, bool showHint)
        {
            _text = text ?? "";
            if (!string.IsNullOrEmpty(accent)) _accent = accent;
            _hint = hint ?? "";
            _showHint = showHint;
            LayoutAndRedraw();
        }

        /// <summary>浮层是否点击穿透。开启时 WindowFromPoint 会跳过浮层，遮挡自检需相应放宽。</summary>
        public bool ClickThrough { get { return _clickThrough; } }

        /// <summary>是否允许拖动浮层。</summary>
        public bool DragEnabled { get { return _dragEnabled; } }

        // 以下四个属性回报**实际生效**的外观参数（已钳制）。主程序据此确认
        // 配置真的送到了原生层，而不是"以为送到了"。
        public int AppliedFontSize { get { return _fontSize; } }
        public int AppliedPadding { get { return _padding; } }
        public int AppliedMarginTop { get { return _marginTop; } }
        public int AppliedOpacity { get { return _opacityPercent; } }

        /// <summary>应用外观配置。必须在 UI 线程调用。</summary>
        public void ApplyStyle(int fontSize, int padding, int marginTop, int opacityPercent,
                               double anchorX, int maxWidthPercent, bool clickThrough)
        {
            _fontSize = Math.Max(10, Math.Min(96, fontSize));
            _padding = Math.Max(4, Math.Min(80, padding));
            _marginTop = marginTop;
            _opacityPercent = Math.Max(20, Math.Min(100, opacityPercent));
            _anchorX = Math.Max(0.0, Math.Min(1.0, anchorX));
            _maxWidthPercent = Math.Max(20, Math.Min(100, maxWidthPercent));
            Opacity = _opacityPercent / 100.0;
            if (_clickThrough != clickThrough)
            {
                _clickThrough = clickThrough;
                ApplyHitTestStyle();
            }
            LayoutAndRedraw();
        }

        private Font BuildFont()
        {
            // 优先中文字体，保证中文识别结果不变豆腐块。
            string[] preferred = { "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI" };
            foreach (string family in preferred)
            {
                try
                {
                    var font = new Font(family, _fontSize, FontStyle.Bold, GraphicsUnit.Pixel);
                    if (string.Equals(font.FontFamily.Name, family, StringComparison.OrdinalIgnoreCase)) return font;
                    font.Dispose();
                }
                catch { }
            }
            return new Font(FontFamily.GenericSansSerif, _fontSize, FontStyle.Bold, GraphicsUnit.Pixel);
        }

        /// <summary>按当前文本重新测量窗口尺寸并摆放到配置的位置。</summary>
        public void LayoutAndRedraw()
        {
            Rectangle screen = Screen.PrimaryScreen.Bounds;
            int maxTextWidth = Math.Max(120, screen.Width * _maxWidthPercent / 100 - _padding * 2);

            Size textSize;
            using (var font = BuildFont())
            using (var bitmap = new Bitmap(1, 1))
            using (var g = Graphics.FromImage(bitmap))
            {
                var proposed = new Size(maxTextWidth, int.MaxValue);
                textSize = TextRenderer.MeasureText(g, _text, font, proposed,
                    TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
            }

            int hintHeight = 0;
            Size hintSize = Size.Empty;
            Font hintFont = null;
            if (_showHint && !string.IsNullOrEmpty(_hint))
            {
                hintFont = new Font(BuildFont().FontFamily, Math.Max(11, _fontSize * 0.5f), FontStyle.Regular, GraphicsUnit.Pixel);
                using (var bitmap = new Bitmap(1, 1))
                using (var g = Graphics.FromImage(bitmap))
                {
                    hintSize = TextRenderer.MeasureText(g, _hint, hintFont, new Size(maxTextWidth, int.MaxValue),
                        TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                }
                hintHeight = hintSize.Height + 8;
            }

            int width = Math.Min(screen.Width, Math.Max(textSize.Width, hintSize.Width) + _padding * 2);
            int height = textSize.Height + hintHeight + _padding * 2;
            Size = new Size(width, height);

            int x = (int)(screen.X + (screen.Width - width) * _anchorX);
            int y = screen.Y + _marginTop;
            Location = new Point(Math.Max(screen.X, Math.Min(x, screen.Right - width)), y);

            if (hintFont != null) hintFont.Dispose();
            Invalidate();
        }

        /// <summary>把窗口重新提到最顶层。用于周期性重申与显示时调用。</summary>
        public void ReassertTopMost()
        {
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            var bounds = new Rectangle(0, 0, Width, Height);
            using (var brush = new SolidBrush(BackColor))
            using (var path = RoundedRect(bounds, 12))
            {
                g.FillPath(brush, path);
            }

            Color accent = ParseColor(_accent, Color.FromArgb(59, 130, 246));
            using (var accentBrush = new SolidBrush(accent))
            {
                g.FillRectangle(accentBrush, 0, 0, 5, Height);
            }

            var textRect = new Rectangle(_padding, _padding,
                Width - _padding * 2, Height - _padding * 2);
            if (_showHint && !string.IsNullOrEmpty(_hint))
            {
                using (var font = BuildFont())
                {
                    Size textSize = TextRenderer.MeasureText(g, _text, font,
                        new Size(textRect.Width, int.MaxValue),
                        TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                    TextRenderer.DrawText(g, _text, font,
                        new Rectangle(textRect.X, textRect.Y, textRect.Width, textSize.Height),
                        Color.White, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                    textRect.Y += textSize.Height + 8;
                    textRect.Height = Math.Max(0, Height - textRect.Y - _padding);
                }
                using (var hintFont = new Font(BuildFont().FontFamily,
                           Math.Max(11, _fontSize * 0.5f), FontStyle.Regular, GraphicsUnit.Pixel))
                {
                    TextRenderer.DrawText(g, _hint, hintFont, textRect,
                        ParseColor("#9CA3AF", Color.Gray),
                        TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                }
            }
            else
            {
                using (var font = BuildFont())
                {
                    TextRenderer.DrawText(g, _text, font, textRect, Color.White,
                        TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                }
            }
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            int d = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static Color ParseColor(string hex, Color fallback)
        {
            if (string.IsNullOrEmpty(hex)) return fallback;
            try
            {
                string value = hex.TrimStart('#');
                if (value.Length == 6)
                {
                    return Color.FromArgb(
                        int.Parse(value.Substring(0, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture),
                        int.Parse(value.Substring(2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture),
                        int.Parse(value.Substring(4, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                }
            }
            catch { }
            return fallback;
        }

        // --- 拖动 -------------------------------------------------------------
        // 拖动期间临时打开命中测试（去掉 WS_EX_TRANSPARENT），否则收不到鼠标。
        private void OnMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            if (!_dragEnabled)
            {
                // 没开拖动：浮层是纯展示的，点击应该穿到游戏里去。
                ApplyHitTestStyle();
                return;
            }
            _dragging = true;
            _dragOrigin = Cursor.Position;
            _dragWindowOrigin = Location;
            ApplyHitTestStyle();
        }

        private void OnMouseMove(object sender, MouseEventArgs e)
        {
            if (!_dragging) return;
            Point now = Cursor.Position;
            Location = new Point(
                _dragWindowOrigin.X + (now.X - _dragOrigin.X),
                _dragWindowOrigin.Y + (now.Y - _dragOrigin.Y));
        }

        private void OnMouseUp(object sender, MouseEventArgs e)
        {
            if (!_dragging) return;
            _dragging = false;
            ApplyHitTestStyle();
            if (Dragged != null) Dragged(Location);
        }

        /// <summary>拖动结束后回调，主程序据此持久化新位置。</summary>
        public event Action<Point> Dragged;

        /// <summary>窗口矩形，供遮挡诊断使用。</summary>
        public Rectangle WindowRect()
        {
            Native.RECT r;
            if (Native.GetWindowRect(Handle, out r)) return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
            return Rectangle.Empty;
        }
    }

    // ========================================================================
    // 全局键盘钩子
    // ========================================================================
    /// <summary>
    /// WH_KEYBOARD_LL 低级键盘钩子。
    ///
    /// 关键约束：回调运行在安装钩子的线程上，且**必须尽快返回**。Windows 对钩子
    /// 回调有超时（注册表 LowLevelHooksTimeout，通常 300ms），超时会把钩子从链上
    /// 摘掉——表现为"按了没反应"，而且不会有任何提示。所以这里只做：查表 → 回报
    /// 事件 → 返回。所有耗时工作（录音、识别、网络）都在主程序里做。
    /// </summary>
    internal sealed class KeyboardHook : IDisposable
    {
        private readonly Native.LowLevelKeyboardProc _proc;   // 必须持有引用，否则会被 GC 回收
        private IntPtr _handle = IntPtr.Zero;
        private readonly HashSet<int> _watched = new HashSet<int>();
        private readonly HashSet<int> _suppressed = new HashSet<int>();
        private readonly HashSet<int> _down = new HashSet<int>();

        /// <summary>
        /// 热键事件回调：参数为虚拟键码、是否按下、以及按住毫秒数。
        ///
        /// 钩子这条路径不测量时长（那需要额外的状态跟踪），所以固定传 0 ——
        /// "按住说话"只由媒体键那条路径支持，它有自己的轮询计时。
        /// 保持签名一致，是为了上层不需要区分事件来源。
        /// </summary>
        public event Action<int, bool, int> KeyEvent;

        /// <summary>钩子安装失败时带回 Win32 错误码。</summary>
        public int LastError { get; private set; }

        public KeyboardHook()
        {
            _proc = Callback;
        }

        /// <summary>订阅一组虚拟键码；只有这些键会被回报（其余直接放行，开销趋近于零）。</summary>
        public void Watch(IEnumerable<int> virtualKeys)
        {
            _watched.Clear();
            if (virtualKeys != null)
                foreach (int vk in virtualKeys) _watched.Add(vk);
        }

        /// <summary>设置在按键时是否吞掉事件（true 则游戏收不到这个键）。</summary>
        public void Suppress(IEnumerable<int> virtualKeys)
        {
            _suppressed.Clear();
            if (virtualKeys != null)
                foreach (int vk in virtualKeys) _suppressed.Add(vk);
        }

        public bool Installed { get { return _handle != IntPtr.Zero; } }

        public bool Install()
        {
            if (_handle != IntPtr.Zero) return true;
            IntPtr module = Native.GetModuleHandle(null);
            _handle = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _proc, module, 0);
            if (_handle == IntPtr.Zero)
            {
                LastError = Marshal.GetLastWin32Error();
                Log.Line("hook install FAILED, GetLastError=" + LastError);
                return false;
            }
            Log.Line("hook installed, watched=" + JoinKeys(_watched));
            return true;
        }

        private IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                try
                {
                    var data = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                    int vk = (int)data.vkCode;
                    if (_watched.Contains(vk))
                    {
                        int message = wParam.ToInt32();
                        bool isDown = message == Native.WM_KEYDOWN || message == Native.WM_SYSKEYDOWN;
                        bool isUp = message == Native.WM_KEYUP || message == Native.WM_SYSKEYUP;
                        if (isDown || isUp)
                        {
                            // 只在状态真正变化时上报，屏蔽键盘自动重复产生的连发。
                            bool changed = isDown ? _down.Add(vk) : _down.Remove(vk);
                            if (changed && KeyEvent != null) KeyEvent(vk, isDown, 0);
                            if (_suppressed.Contains(vk)) return new IntPtr(1);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log.Line("hook callback exception: " + ex.Message);
                }
            }
            return Native.CallNextHookEx(_handle, nCode, wParam, lParam);
        }

        private static string JoinKeys(IEnumerable<int> keys)
        {
            var sb = new StringBuilder();
            foreach (int k in keys)
            {
                if (sb.Length > 0) sb.Append(',');
                sb.Append(k);
            }
            return sb.ToString();
        }

        public void Dispose()
        {
            if (_handle != IntPtr.Zero)
            {
                Native.UnhookWindowsHookEx(_handle);
                _handle = IntPtr.Zero;
                Log.Line("hook removed");
            }
        }
    }

    // ========================================================================
    // 媒体键监听（RegisterHotKey + 轮询检测抬起）
    // ========================================================================
    /// <summary>
    /// 用全局热键监听一组**媒体键**，并给出"按下 / 抬起 + 按住时长"。
    ///
    /// ## 为什么不用低级键盘钩子
    ///
    /// 实测 CFHD 的反作弊会拦掉 `WH_KEYBOARD_LL`：普通按键在游戏里完全读不到。
    /// 但用户发现**键盘上的媒体键在游戏里仍有反应** —— 这类键走 HID 的 Consumer
    /// Control 用法页（0x0C），和键盘用法页（0x06）不是同一条路，而反作弊只挂了
    /// 后者。`RegisterHotKey` 又是系统在分发给前台窗口**之前**处理的，所以它成了
    /// 唯一有希望穿透的机制。
    ///
    /// ## 为什么要轮询
    ///
    /// `WM_HOTKEY` **只在按下时投递一次，没有抬起事件**。而"按住录音、抬起识别"
    /// 恰恰需要抬起时刻。所以按下后用 `GetAsyncKeyState` 每 20ms 查一次，直到
    /// 该键不再按下为止；按住时长就是两者的时间差。
    ///
    /// 轮询由宿主窗口的定时器驱动（`Poll`），全部在 UI 线程上执行。
    /// </summary>
    internal sealed class MediaKeyWatcher : IDisposable
    {
        /// <summary>热键 id 的起始值；0 保留不用（RegisterHotKey 的 id 要求非零）。</summary>
        private const int FirstHotkeyId = 0xA000;

        private readonly IntPtr _windowHandle;

        /// <summary>
        /// 已注册的媒体键。用 id→虚拟键码 的字典而不是列表：注册可能部分失败
        /// （键被别的程序占用），若用"起始 id + 下标"推算，一次失败就会让后面
        /// 所有键的 id 与下标错位，回执里全是 "unknown id"。
        /// </summary>
        private readonly Dictionary<int, int> _registeredKeys = new Dictionary<int, int>();

        /// <summary>
        /// 按键事件：虚拟键码、是否按下、按住毫秒数。
        ///
        /// ## 为什么只有"按下"，没有"抬起"
        ///
        /// `RegisterHotKey` 本身只派发按下。第一版为了拿到"按住多久"，额外用
        /// 20ms 的定时器轮询 `GetAsyncKeyState` 来判断何时松开。
        ///
        /// **那个轮询后来被删掉了**，两个原因：
        ///
        /// 1. 上层（插件）只处理 `down` 事件 —— 交互本来就是"按一下切换"，
        ///    抬起事件从头到尾没人用，`heldMs` 也没人读。
        /// 2. `GetAsyncKeyState` 是**键盘记录器的典型 API**。反作弊未必会因此
        ///    判定什么，但"有一个进程在轮询键盘状态"这件事没有任何理由出现在
        ///    这个工具里 —— 少一个可疑特征就是少一分风险。
        ///
        /// 代价：按住媒体键不会再产生抬起事件。因为注册时带了 `MOD_NOREPEAT`，
        /// 按住也不会重复触发，所以行为上没有任何变化。
        /// </summary>
        public event Action<int, bool, int> KeyEvent;

        public MediaKeyWatcher(IntPtr windowHandle)
        {
            _windowHandle = windowHandle;
        }

        /// <summary>上一次注册的结果说明，供回执与日志使用。</summary>
        public string LastRegistrationReport { get; private set; }

        /// <summary>
        /// 注册（或重新注册）一组媒体键。
        ///
        /// 幂等：重复调用会先注销再注册，所以配置变化时直接再调即可。
        /// **单个键注册失败不致命** —— 常见原因是被别的程序占用了（比如
        /// "下一曲"往往已被音乐播放器或系统占用），只记下来并在回执里报告。
        /// </summary>
        public void Register(IEnumerable<int> virtualKeys)
        {
            Unregister();

            var accepted = new List<string>();
            var failed = new List<string>();

            int id = FirstHotkeyId;
            foreach (int vk in virtualKeys)
            {
                if (_registeredKeys.ContainsValue(vk)) continue;
                if (Native.RegisterHotKey(_windowHandle, id, Native.MOD_NOREPEAT, (uint)vk))
                {
                    _registeredKeys[id] = vk;
                    accepted.Add(KeyNames.Describe(vk));
                    id++;
                }
                else
                {
                    // 只把**键名**放进回执、错误码放进日志：回执要显示给用户看，
                    // 而 "err 1409" 对用户毫无意义（它几乎总是"已被别的程序占用"）。
                    failed.Add(KeyNames.Describe(vk));
                    Log.Line("RegisterHotKey failed for " + KeyNames.Describe(vk) +
                             " vk=" + vk + " err=" + Marshal.GetLastWin32Error());
                }
            }

            LastRegistrationReport = "ok=" + string.Join(",", accepted.ToArray()) +
                (failed.Count > 0 ? " failed=" + string.Join(",", failed.ToArray()) : "");
            Log.Line("media keys registered: " + LastRegistrationReport);
        }

        /// <summary>主机收到 WM_HOTKEY 时调用。wParam 是热键 id。</summary>
        public void OnHotkeyMessage(int hotkeyId)
        {
            int vk;
            if (!_registeredKeys.TryGetValue(hotkeyId, out vk))
            {
                Log.Line("media key hotkey with unknown id " + hotkeyId);
                return;
            }
            // 只上报按下。抬起事件与 getAsyncKeyState 轮询一起被删掉了，
            // 原因见 KeyEvent 的说明。
            Raise(vk, true, 0);
        }

        private void Raise(int virtualKey, bool isDown, int heldMs)
        {
            if (KeyEvent != null) KeyEvent(virtualKey, isDown, heldMs);
        }

        private void Unregister()
        {
            foreach (int id in _registeredKeys.Keys)
            {
                try { Native.UnregisterHotKey(_windowHandle, id); }
                catch { /* 已经没了 */ }
            }
            _registeredKeys.Clear();
        }

        public void Dispose()
        {
            Unregister();
        }
    }

    // ========================================================================
    // 消息循环宿主
    // ========================================================================
    /// <summary>
    /// 进程骨架。用一个隐藏的 Form 承载消息循环（低级键盘钩子必须有消息泵），
    /// 后台线程读 stdin 入队，UI 线程的定时器排空队列。
    /// </summary>
    internal sealed class Host : Form
    {
        private readonly ConcurrentQueue<Dictionary<string, object>> _inbox =
            new ConcurrentQueue<Dictionary<string, object>>();
        private readonly OverlayForm _overlay = new OverlayForm();
        private readonly KeyboardHook _hook = new KeyboardHook();
        // 显式限定 Forms.Timer：本文件同时 using 了 System.Threading，Timer 会歧义。
        private readonly System.Windows.Forms.Timer _pump = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _reassert = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _parentWatch = new System.Windows.Forms.Timer();

        private bool _overlayVisible;
        private bool _readySent;
        private int _reassertSeconds = 2;
        private int _reassertTicks = 0;
        private int _parentPid;
        private bool _consumeKeys = true;
        private bool _shuttingDown;
        /// <summary>用户是否从托盘菜单点了"退出"。用来区分人工退出与崩溃，避免被自动重启。</summary>
        private bool _exitRequested;
        /// <summary>
        /// 托盘图标。存在理由：本进程由 DSH 拉起，与用户的终端窗口无关，
        /// 没有它用户无法判断插件在不在运行（实测：用户以为关掉 PowerShell 就会结束它）。
        /// </summary>
        private TrayIcon _tray;
        /// <summary>
        /// 媒体键监听。只用 `RegisterHotKey` 收按下事件。
        ///
        /// **它不轮询键盘状态** —— 这一条是刻意的：`GetAsyncKeyState` 是键盘记录器
        /// 的典型 API，而"有一个进程在轮询键盘"没有任何理由出现在这个工具里。
        /// 详见 `MediaKeyWatcher.KeyEvent` 的说明。
        /// </summary>
        private MediaKeyWatcher _mediaKeys;

        public Host(int parentPid)
        {
            _parentPid = parentPid;
            // 隐藏宿主窗口：只提供消息循环，不显示任何东西。
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
            Load += OnLoad;
            FormClosing += OnFormClosing;
            _hook.KeyEvent += OnHookKeyEvent;
            _overlay.Dragged += OnOverlayDragged;
        }

        private void OnLoad(object sender, EventArgs e)
        {
            // 宿主窗口永远不显示，但仍然需要有一个句柄来接收线程消息。
            Hide();

            bool hookOk = _hook.Install();

            _pump.Interval = 12;
            _pump.Tick += (s, a) => Drain();
            _pump.Start();

            _reassert.Interval = 1000;
            _reassert.Tick += (s, a) => ReassertTick();
            _reassert.Start();

            StartParentWatch();
            StartInputThread();

            // 媒体键监听。与键盘钩子并存：钩子负责普通按键（在支持的场景里），
            // 媒体键负责穿透反作弊的那条路。两者都通过 OnKeyEvent 上报。
            _mediaKeys = new MediaKeyWatcher(Handle);
            _mediaKeys.KeyEvent += OnMediaKeyEvent;

            // 托盘图标：用户无法从终端或 DSH 界面判断这个进程在不在跑，
            // 所以必须给一个常驻可见的标志。创建失败不影响热键与浮层。
            try
            {
                _tray = new TrayIcon();
                _tray.ExitRequested += delegate
                {
                    // 记下这是人工退出，让主程序不要把我们拉起来。
                    _exitRequested = true;
                    Log.Line("exit requested from tray menu");
                    Close();
                };
                Log.Line("tray icon created");
            }
            catch (Exception ex)
            {
                Log.Line("tray icon failed: " + ex.Message);
            }

            Emit("ready", null,
                "pid", Process.GetCurrentProcess().Id,
                "hookInstalled", hookOk,
                "hookError", hookOk ? null : (object)_hook.LastError,
                "x64", Environment.Is64BitProcess);
            _readySent = true;
            Log.Line("ready emitted, hookInstalled=" + hookOk);
        }

        private void ReassertTick()
        {
            if (!_overlayVisible || _overlay.IsDragging) return;
            // 有些游戏（或 Windows 全屏优化）会把置顶窗口挤下去，周期性重申一次。
            // 用计数器而不是 TickCount 取模：后者依赖定时器与系统时钟的相位关系，
            // 在定时器抖动时可能整个周期都命中不了条件。
            int seconds = _reassertSeconds <= 0 ? 2 : _reassertSeconds;
            _reassertTicks++;
            if (_reassertTicks < seconds) return;
            _reassertTicks = 0;
            _overlay.ReassertTopMost();
        }

        /// <summary>
        /// 接收窗口消息。唯一需要处理的是媒体键的 WM_HOTKEY —— 它由系统投递，
        /// 不经过低级钩子，这也是媒体键能穿透反作弊的原因。
        /// </summary>
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY && _mediaKeys != null)
            {
                _mediaKeys.OnHotkeyMessage(m.WParam.ToInt32());
            }
            base.WndProc(ref m);
        }

        /// <summary>
        /// 父进程守护。stdio 关闭通常足以让我们退出，但主程序被强杀（崩溃、
        /// 任务管理器结束进程）时管道不一定立刻断，而一个残留的 sidecar 会继续
        /// 抓着全局热键不放——表现为"F9 突然不管用了，但游戏里也没反应"。
        /// 所以额外显式盯着父进程。
        /// </summary>
        private void StartParentWatch()
        {
            if (_parentPid <= 0) return;
            _parentWatch.Interval = 2000;
            _parentWatch.Tick += (s, a) =>
            {
                try
                {
                    Process.GetProcessById(_parentPid);
                }
                catch (ArgumentException)
                {
                    Log.Line("parent process " + _parentPid + " is gone, exiting to avoid orphan");
                    Close();
                }
                catch (Exception ex)
                {
                    Log.Line("parent watch check failed: " + ex.Message);
                }
            };
            _parentWatch.Start();
            Log.Line("watching parent pid " + _parentPid);
        }

        private void StartInputThread()
        {
            var thread = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Protocol.ReadLine()) != null)
                    {
                        var message = Json.Parse(line);
                        if (message.Count > 0) _inbox.Enqueue(message);
                    }
                }
                catch (Exception ex)
                {
                    Log.Line("input thread exception: " + ex.Message);
                }
                // stdin 关闭 = 主程序没了，跟着退出，绝不留孤儿进程。
                Log.Line("stdin closed, shutting down");
                try { BeginInvoke(new Action(Close)); } catch { }
            });
            thread.IsBackground = true;
            thread.Name = "sidecar-stdin";
            thread.Start();
        }

        private void Drain()
        {
            Dictionary<string, object> message;
            while (_inbox.TryDequeue(out message))
            {
                try { Dispatch(message); }
                catch (Exception ex)
                {
                    Emit("error", null, "message", ex.Message, "type", ex.GetType().Name);
                    Log.Line("handler exception: " + ex);
                }
            }
        }

        /// <summary>
        /// 处理一条已解析的入站消息。刻意不叫 Handle —— Form 已经有同名属性，
        /// 会触发 CS0108 且埋下"到底调的是哪个"的隐患。
        /// </summary>
        private void Dispatch(Dictionary<string, object> message)
        {
            string type = Json.GetString(message, "type", "");
            switch (type)
            {
                case "configure":
                    HandleConfigure(message);
                    break;
                case "show":
                    HandleShow(message);
                    break;
                case "hide":
                    HideOverlay();
                    Emit("state", Json.GetString(message, "state", "hidden"));
                    break;
                case "ping":
                    Emit("pong", Json.GetString(message, "id", null), "uptimeMs", Environment.TickCount);
                    break;
                case "verify":
                    EmitVerification(Json.GetString(message, "id", null));
                    break;
                case "beep":
                    HandleBeep(message);
                    break;
                case "shutdown":
                    Log.Line("shutdown requested");
                    Close();
                    break;
                default:
                    Emit("error", Json.GetString(message, "id", null),
                        "message", "unknown message type: " + type);
                    break;
            }
        }

        private void HandleConfigure(Dictionary<string, object> message)
        {
            var keys = Json.GetString(message, "keys", null);
            var watched = new List<int>();
            var labels = new Dictionary<int, string>();
            if (!string.IsNullOrEmpty(keys))
            {
                foreach (string token in keys.Split(','))
                {
                    string trimmed = token.Trim();
                    if (trimmed.Length == 0) continue;
                    int vk;
                    if (int.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out vk))
                    {
                        watched.Add(vk);
                        labels[vk] = KeyNames.Describe(vk);
                    }
                }
            }

            // 先解析成局部变量再决定吞不吞键：既避免两次读取配置，
            // 也让"是否吞键"和"实际注册的吞键集合"来自同一个值。
            bool consumeKeys = Json.GetBool(message, "consumeKeys", _consumeKeys);
            _consumeKeys = consumeKeys;

            _hook.Watch(watched);
            _hook.Suppress(consumeKeys ? watched : new List<int>());
            _reassertSeconds = (int)Json.GetLong(message, "reassertSeconds", _reassertSeconds);

            // 媒体键走另一条通道（RegisterHotKey）。它不能吞键 —— 那是共享资源，
            // 别的程序（音乐播放器、系统音量）可能也在等这些键。
            var mediaRaw = Json.GetString(message, "mediaKeys", null);
            var mediaWatched = new List<int>();
            if (!string.IsNullOrEmpty(mediaRaw))
            {
                foreach (string token in mediaRaw.Split(','))
                {
                    string trimmed = token.Trim();
                    if (trimmed.Length == 0) continue;
                    int vk;
                    if (int.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out vk))
                    {
                        mediaWatched.Add(vk);
                        labels[vk] = KeyNames.Describe(vk);
                    }
                }
            }
            if (_mediaKeys != null) _mediaKeys.Register(mediaWatched);

            _overlay.ApplyStyle(
                (int)Json.GetLong(message, "fontSize", 26),
                (int)Json.GetLong(message, "padding", 18),
                (int)Json.GetLong(message, "marginTop", 0),
                (int)Json.GetLong(message, "opacity", 88),
                Json.GetLong(message, "anchorXPercent", 50) / 100.0,
                (int)Json.GetLong(message, "maxWidthPercent", 80),
                Json.GetBool(message, "clickThrough", true));
            _overlay.SetDragEnabled(Json.GetBool(message, "draggable", true));

            Emit("configured", Json.GetString(message, "id", null),
                "watched", string.Join(",", watched.ConvertAll(v => v.ToString(CultureInfo.InvariantCulture)).ToArray()),
                "labels", string.Join(",", new List<string>(labels.Values).ToArray()),
                "consumeKeys", _consumeKeys,
                // 回报实际生效的外观参数。这不只是调试便利：它是"设置真的从
                // 主程序传到了原生层"的唯一客观证据——配置链路上任何一环断了
                // （schema 没解析、字段漏传、钳制过头）都会在这里显形。
                "fontSize", _overlay.AppliedFontSize,
                "padding", _overlay.AppliedPadding,
                "marginTop", _overlay.AppliedMarginTop,
                "opacity", _overlay.AppliedOpacity,
                "clickThrough", _overlay.ClickThrough,
                "draggable", _overlay.DragEnabled,
                // 媒体键的注册结果必须回报：单个键可能被别的程序占用而注册失败
                // （"下一曲"经常被音乐播放器抢先），不报出来用户只会觉得
                // "这个键没反应"，无从判断是没配好还是被占用了。
                "mediaKeys", string.Join(",", mediaWatched.ConvertAll(
                    v => v.ToString(CultureInfo.InvariantCulture)).ToArray()),
                "mediaKeysReport", _mediaKeys == null ? "" : _mediaKeys.LastRegistrationReport);
        }

        /// <summary>
        /// 播放提示音。
        ///
        /// ## 为什么这件事归 sidecar 做
        ///
        /// 第一版是在主程序里 `spawn('powershell.exe', ['-Command', '[console]::beep(...)'])`。
        /// 那有两个问题，第一个是主要的：
        ///
        /// 1. **每按一次键就有一个 powershell.exe 被启动**。powershell 的启动是
        ///    恶意软件的高频特征，某些安全软件会对它格外上心 —— 而这个工具只是
        ///    想"嘀"一声，没有任何理由把 powershell 牵扯进来。
        /// 2. 每次都要等进程起来（一百多毫秒），提示音因此总是慢半拍。
        ///
        /// sidecar 本来就是个常驻的原生进程，直接调 `Console.Beep` 零开销。
        ///
        /// `Console.Beep` 是**阻塞**的（它同步播完才返回），所以绝不能在这个
        /// UI 线程上调 —— 那会把消息循环和浮层一起卡住。丢给线程池。
        /// </summary>
        private void HandleBeep(Dictionary<string, object> message)
        {
            string tones = Json.GetString(message, "tones", "");
            if (tones.Length == 0) return;

            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    foreach (string tone in tones.Split(','))
                    {
                        string[] parts = tone.Split(':');
                        if (parts.Length != 2) continue;
                        int frequency, duration;
                        if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out frequency)) continue;
                        if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out duration)) continue;
                        Console.Beep(frequency, duration);
                    }
                }
                catch (Exception ex)
                {
                    // 某些系统上 Beep 会失败（没有可用的蜂鸣设备）。提示音不是
                    // 关键路径，记一行日志就够了。
                    Log.Line("beep failed: " + ex.Message);
                }
            });
        }

        private void HandleShow(Dictionary<string, object> message)
        {
            string text = Json.GetString(message, "text", "");
            string accent = Json.GetString(message, "accent", null);
            string hint = Json.GetString(message, "hint", null);
            bool showHint = Json.GetBool(message, "showHint", true);
            string state = Json.GetString(message, "state", "shown");

            IntPtr foregroundBefore = Native.GetForegroundWindow();
            bool wasVisible = _overlayVisible;

            _overlay.ApplyContent(text, accent, hint, showHint);
            if (!_overlayVisible)
            {
                // 用 Show() 而不是 ShowDialog()；ShowWithoutActivation + WS_EX_NOACTIVATE
                // 保证它出现时不夺走游戏焦点。
                _overlay.Show();
                _overlayVisible = true;
            }
            _overlay.ReassertTopMost();
            _overlay.Invalidate();

            IntPtr foregroundAfter = Native.GetForegroundWindow();
            Rectangle rect = _overlay.WindowRect();

            Emit("shown", Json.GetString(message, "id", null),
                "state", state,
                "text", text,
                "alreadyVisible", wasVisible,
                "overlayHwnd", _overlay.Handle.ToInt64(),
                "rect", string.Format(CultureInfo.InvariantCulture, "{0},{1},{2},{3}",
                    rect.Left, rect.Top, rect.Width, rect.Height),
                "topMost", (_overlay.TopMost ? 1 : 0),
                "foregroundBefore", foregroundBefore.ToInt64(),
                "foregroundAfter", foregroundAfter.ToInt64(),
                "focusKept", foregroundBefore == foregroundAfter);
        }

        private void HideOverlay()
        {
            if (!_overlayVisible) return;
            _overlay.Hide();
            _overlayVisible = false;
        }

        /// <summary>
        /// 上报一次按键。
        ///
        /// `phase=down/up` 与 `heldMs` 只有抬起事件才非零。上层用它们区分
        /// "轻按"与"长按"（媒体键的 RegisterHotKey 没有抬起事件，时长是 sidecar
        /// 自己用轮询量出来的）。
        ///
        /// `source` 区分两条物理通道（`hook` = 低级键盘钩子，`media` = 媒体键热键）。
        /// 必须报出来：同一个键码可能同时出现在两边的配置里，上层据此查不同的动作表，
        /// 否则一次按键会触发两个动作。
        /// </summary>
        private void OnKeyEvent(string source, int virtualKey, bool isDown, int heldMs)
        {
            Emit("key", null,
                "vk", virtualKey,
                "key", KeyNames.Describe(virtualKey),
                "source", source,
                "phase", isDown ? "down" : "up",
                "heldMs", heldMs,
                "foreground", DescribeForeground());
        }

        private void OnHookKeyEvent(int virtualKey, bool isDown, int heldMs)
        {
            OnKeyEvent("hook", virtualKey, isDown, heldMs);
        }

        private void OnMediaKeyEvent(int virtualKey, bool isDown, int heldMs)
        {
            OnKeyEvent("media", virtualKey, isDown, heldMs);
        }

        private void OnOverlayDragged(Point location)
        {
            Emit("moved", null, "x", location.X, "y", location.Y);
        }

        /// <summary>
        /// 应答 verify：回报浮层当前的物理状态，让主程序（和我）不必靠肉眼判断
        /// 浮层是否真的压在游戏上面。
        ///
        /// visibleOnScreen 用 WindowFromPoint 采样窗口中心点：如果那个点上最顶层的
        /// 窗口不是我们的浮层，就说明浮层被别的置顶窗口挡住了。
        /// </summary>
        private void EmitVerification(string id)
        {
            if (!_overlayVisible)
            {
                Emit("verification", id, "visible", false, "reason", "overlay hidden");
                return;
            }

            Rectangle rect = _overlay.WindowRect();
            var center = new Native.POINT
            {
                X = rect.Left + rect.Width / 2,
                Y = rect.Top + rect.Height / 2
            };
            IntPtr topAtCenter = Native.WindowFromPoint(center);
            IntPtr overlayHandle = _overlay.Handle;
            bool selfAtCenter = topAtCenter == overlayHandle;

            // 开了点击穿透时，WindowFromPoint 会被 WS_EX_TRANSPARENT 直接跳过，
            // 所以"中心点上不是自己"在这种情况下是**预期行为**，不能当作被遮挡。
            // 这里把两种原因分开报告，避免自检给出误导性结论。
            string occluded = "no";
            if (!selfAtCenter)
            {
                if (_overlay.ClickThrough) occluded = "skipped-transparent";
                else occluded = "yes";
            }

            var screen = Screen.FromRectangle(rect).Bounds;
            bool withinScreen = rect.Width > 0 && rect.Height > 0 &&
                                rect.Left >= screen.Left - 1 && rect.Top >= screen.Top - 1 &&
                                rect.Right <= screen.Right + 1 && rect.Bottom <= screen.Bottom + 1;

            IntPtr foreground = Native.GetForegroundWindow();

            Emit("verification", id,
                "visible", _overlay.Visible && Native.IsWindowVisible(overlayHandle),
                "selfAtCenter", selfAtCenter,
                "occluded", occluded,
                "clickThrough", _overlay.ClickThrough,
                "topWindowAtCenter", topAtCenter.ToInt64(),
                "overlayHwnd", overlayHandle.ToInt64(),
                "rect", string.Format(CultureInfo.InvariantCulture, "{0},{1},{2},{3}",
                    rect.Left, rect.Top, rect.Width, rect.Height),
                "withinScreen", withinScreen,
                "screen", string.Format(CultureInfo.InvariantCulture, "{0},{1},{2},{3}",
                    screen.Left, screen.Top, screen.Width, screen.Height),
                "foreground", DescribeForeground(),
                "foregroundHwnd", foreground.ToInt64(),
                "text", _overlay.CurrentText);
        }

        private static string DescribeForeground()
        {
            IntPtr hwnd = Native.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return "(none)";
            var title = new StringBuilder(256);
            Native.GetWindowText(hwnd, title, title.Capacity);
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            string process = "?";
            try { process = Process.GetProcessById((int)pid).ProcessName; }
            catch { }
            return process + " | " + title.ToString();
        }

        /// <summary>向 stdout 写一条协议消息。加锁保证不会交错写坏一行。</summary>
        private void Emit(string type, string id, params object[] keyValues)
        {
            var fields = new Dictionary<string, object>(StringComparer.Ordinal);
            fields["type"] = type;
            if (id != null) fields["id"] = id;
            for (int i = 0; i + 1 < keyValues.Length; i += 2)
            {
                string key = Convert.ToString(keyValues[i], CultureInfo.InvariantCulture);
                object value = keyValues[i + 1];
                if (key != null) fields[key] = value;
            }

            string line = Json.Write(fields);
            Protocol.WriteLine(line);
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (_shuttingDown) return;
            _shuttingDown = true;
            try { _pump.Stop(); _reassert.Stop(); _parentWatch.Stop(); } catch { }
            try { if (_mediaKeys != null) _mediaKeys.Dispose(); } catch { }
            try { _hook.Dispose(); } catch { }
            try { if (_overlayVisible) _overlay.Hide(); } catch { }
            // 托盘图标必须先移除再释放，否则任务栏会留下一个点不动的幽灵图标。
            try { if (_tray != null) _tray.Dispose(); } catch { }
            Log.Line("host closing");

            // 必须告诉主程序"这次退出是用户要求的"。
            //
            // 为什么关键：主程序有自动重启（崩溃自愈）。如果不区分退出原因，
            // 用户点托盘"退出"→ 进程结束 → 主程序当成崩溃 → 立刻拉起来，
            // 表现就是"点了退出它又自己冒出来，根本关不掉"。
            // 主程序据此决定不重启。
            if (_readySent)
            {
                Emit("bye", null,
                    "reason", _exitRequested ? "user-requested" : "shutdown",
                    "intentional", _exitRequested);
            }
        }
    }

    // ========================================================================
    // 虚拟键码 → 可读名字（只覆盖本项目会用到的键，够用即可）
    // ========================================================================
    internal static class KeyNames
    {
        private static readonly Dictionary<int, string> Names = new Dictionary<int, string>
        {
            { 0x08, "Backspace" }, { 0x09, "Tab" }, { 0x0D, "Enter" }, { 0x13, "Pause" },
            { 0x14, "CapsLock" }, { 0x1B, "Esc" }, { 0x20, "Space" },
            { 0x21, "PageUp" }, { 0x22, "PageDown" }, { 0x23, "End" }, { 0x24, "Home" },
            { 0x25, "Left" }, { 0x26, "Up" }, { 0x27, "Right" }, { 0x28, "Down" },
            { 0x2C, "PrintScreen" }, { 0x2D, "Insert" }, { 0x2E, "Delete" },
            { 0x5B, "LWin" }, { 0x5C, "RWin" }, { 0x5D, "Menu" },
            { 0x90, "NumLock" }, { 0x91, "ScrollLock" },
            { 0xA0, "LShift" }, { 0xA1, "RShift" }, { 0xA2, "LCtrl" }, { 0xA3, "RCtrl" },
            { 0xA4, "LAlt" }, { 0xA5, "RAlt" },
            { 0x60, "Num0" }, { 0x61, "Num1" }, { 0x62, "Num2" }, { 0x63, "Num3" },
            { 0x64, "Num4" }, { 0x65, "Num5" }, { 0x66, "Num6" }, { 0x67, "Num7" },
            { 0x68, "Num8" }, { 0x69, "Num9" }, { 0x6A, "Num*" }, { 0x6B, "Num+" },
            { 0x6D, "Num-" }, { 0x6E, "Num." }, { 0x6F, "Num/" },
            { 0xBA, ";" }, { 0xBB, "=" }, { 0xBC, "," }, { 0xBD, "-" },
            { 0xBE, "." }, { 0xBF, "/" }, { 0xC0, "`" },
            { 0xDB, "[" }, { 0xDC, "\\" }, { 0xDD, "]" }, { 0xDE, "'" },
            // 媒体键 / 浏览器键。名字与主程序 src/keys.ts、以及浏览器的
            // KeyboardEvent.key 保持一致 —— 回执要原样显示给用户，
            // 三处名字不一致会让人以为是三件不同的事。
            { 0xA6, "BrowserBack" }, { 0xA7, "BrowserForward" }, { 0xA8, "BrowserRefresh" },
            { 0xA9, "BrowserStop" }, { 0xAA, "BrowserSearch" }, { 0xAB, "BrowserFavorites" },
            { 0xAC, "BrowserHome" },
            { 0xAD, "AudioVolumeMute" }, { 0xAE, "AudioVolumeDown" }, { 0xAF, "AudioVolumeUp" },
            { 0xB0, "MediaTrackNext" }, { 0xB1, "MediaTrackPrevious" },
            { 0xB2, "MediaStop" }, { 0xB3, "MediaPlayPause" },
            { 0xB4, "LaunchMail" }, { 0xB5, "LaunchMediaSelect" }
        };

        /// <summary>把虚拟键码转成人类可读的名字；未知键返回 VK_0x 形式。</summary>
        public static string Describe(int virtualKey)
        {
            string name;
            if (Names.TryGetValue(virtualKey, out name)) return name;
            if (virtualKey >= 0x70 && virtualKey <= 0x87) return "F" + (virtualKey - 0x6F);   // F1..F24
            if (virtualKey >= 0x30 && virtualKey <= 0x39) return ((char)virtualKey).ToString();
            if (virtualKey >= 0x41 && virtualKey <= 0x5A) return ((char)virtualKey).ToString();
            return "VK_0x" + virtualKey.ToString("X2", CultureInfo.InvariantCulture);
        }
    }

    // ========================================================================
    // 入口
    // ========================================================================
    internal static class Program
    {
        /// <summary>
        /// 从 `--parent-pid N` 里取父进程 pid，用于父进程守护。
        /// 解析不出来就返回 0，表示"不启用守护"（手工调试时就是这个情况）。
        /// </summary>
        private static int ParseParentPid(string[] args)
        {
            if (args == null) return 0;
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (!string.Equals(args[i], "--parent-pid", StringComparison.OrdinalIgnoreCase)) continue;
                int pid;
                if (int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) return pid;
            }
            return 0;
        }

        [STAThread]
        private static void Main(string[] args)
        {
            // 每个 sidecar 实例一份日志，按 pid 区分，避免多实例互相覆盖。
            Log.Initialize(Path.Combine(Path.GetTempPath(), "dsh-voice-danmaku",
                "sidecar-" + Process.GetCurrentProcess().Id + ".log"));
            Log.Line("sidecar starting, args=" + string.Join(" ", args));

            try { Native.SetProcessDPIAware(); }
            catch { /* 老系统上失败不影响功能，只是高 DPI 下字会糊 */ }

            // 协议通道必须最先建立：/target:winexe 下没有控制台，Console 的默认流
            // 在启动时就已缓存且可能无效，所以这里直接抓标准句柄。
            if (!Protocol.Open())
            {
                // 没有可用的 stdio 就意味着主程序永远不会收到我们的话，
                // 与其静默变成一个"按了没反应"的僵尸进程，不如直接退出。
                Log.Line("fatal: cannot open stdio protocol channel");
                Environment.Exit(2);
            }
            Log.Line("stdio protocol channel ready");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new Host(ParseParentPid(args)));
            }
            catch (Exception ex)
            {
                Log.Line("fatal: " + ex);
                Environment.ExitCode = 1;
            }
        }
    }
}
