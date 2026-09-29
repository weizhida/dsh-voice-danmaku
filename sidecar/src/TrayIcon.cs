// ============================================================================
// 托盘图标 —— 让用户知道插件在运行，并提供一个"退出"入口
// ============================================================================
// 为什么需要它：sidecar 是由 DSH 拉起的独立进程，和用户的终端窗口没有关系。
// 没有这个图标，用户完全无法判断"插件到底在不在跑"——实测中用户以为关掉
// PowerShell 就会结束它，结果它一直在后台运行，也没法停掉它。
//
// ## 刻意只做两件事
//
//   1. 一个**固定配色**的麦克风图标 + 悬浮提示，表明"语音弹幕正在后台运行"；
//   2. 右键菜单里的「退出」，可以真正结束它。
//
// 这里**不做状态变色**。曾经做过（录音变红、识别变琥珀…），但实测用户既看不到
// 变化、也不需要——识别状态本来就由浮层负责显示（那才是用户看的地方）。
// 一个不会变色的常驻图标同样能回答"它在不在跑"，而这才是托盘要解决的问题。
// 加状态色只增加了状态同步的耦合面，收益为零。
//
// 图标是**程序内绘制**的，不依赖任何 .ico 文件：不用随包分发资源，也不会因为
// 路径问题找不到图标。
// ============================================================================

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DshVoiceDanmaku
{
    /// <summary>托盘图标：一个麦克风，加一个能真正退出的菜单。</summary>
    internal sealed class TrayIcon : IDisposable
    {
        private readonly NotifyIcon _icon;
        private readonly Icon _glyph;
        private bool _disposed;

        /// <summary>用户点击"退出"时触发。sidecar 收到后自行关闭。</summary>
        public event Action ExitRequested;

        public TrayIcon()
        {
            _glyph = Draw();

            _icon = new NotifyIcon
            {
                Icon = _glyph,
                Text = "语音弹幕正在后台运行\n右键可退出",
                Visible = true
            };

            var menu = new ContextMenuStrip();
            menu.Items.Add("语音弹幕正在后台运行").Enabled = false;
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出语音弹幕", null, delegate
            {
                if (ExitRequested != null) ExitRequested();
            });
            _icon.ContextMenuStrip = menu;
        }

        /// <summary>在托盘上弹一个气泡提示。用于"发送成功/失败"这类需要一眼看到的结果。</summary>
        public void Notify(string title, string text, bool isError)
        {
            if (_disposed) return;
            try
            {
                _icon.BalloonTipTitle = title;
                _icon.BalloonTipText = text;
                _icon.BalloonTipIcon = isError ? ToolTipIcon.Error : ToolTipIcon.Info;
                _icon.ShowBalloonTip(3000);
            }
            catch
            {
                // 气泡提示失败不影响主流程（某些系统设置会禁用它）
            }
        }

        /// <summary>画一个 32×32 的麦克风图标（系统会缩放到托盘所需尺寸）。</summary>
        private static Icon Draw()
        {
            const int size = 32;
            using (var bitmap = new Bitmap(size, size))
            using (var g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);

                // 深色圆底：保证在浅色和深色任务栏上都看得清
                using (var background = new SolidBrush(Color.FromArgb(235, 32, 36, 44)))
                {
                    g.FillEllipse(background, 0, 0, size - 1, size - 1);
                }

                // 麦克风用品牌蓝，和浮层的"等待确认"配色一致，便于和本插件建立联想
                var accent = Color.FromArgb(77, 107, 254);

                using (var body = new SolidBrush(accent))
                {
                    g.FillEllipse(body, 11, 5, 10, 14);
                }

                using (var pen = new Pen(accent, 2.4f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    g.DrawArc(pen, 8, 11, 16, 14, 0, 180);
                    g.DrawLine(pen, 16, 25, 16, 28);
                    g.DrawLine(pen, 12, 28, 20, 28);
                }

                // 靠 Icon.FromHandle 得到的 Icon 拥有位图的句柄，位图一旦释放图标就坏了。
                // 所以克隆一份真正独立的 Icon，再释放原句柄。
                IntPtr handle = bitmap.GetHicon();
                try
                {
                    using (var temporary = Icon.FromHandle(handle))
                    {
                        return (Icon)temporary.Clone();
                    }
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr handle);

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            // 先把图标从托盘移除再释放，否则任务栏会留下一个点不动的幽灵图标
            if (_icon != null)
            {
                _icon.Visible = false;
                _icon.Dispose();
            }
            if (_glyph != null) _glyph.Dispose();
        }
    }
}
