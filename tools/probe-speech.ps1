# ============================================================================
# Win11 自带语音识别 —— 可行性验证
# ============================================================================
# 用途：判断能不能用 Windows 自带的 SAPI 识别替代云端 ASR（省掉 API 密钥、
# 不需要联网、延迟更低）。
#
# 为什么需要你亲自跑：我（助手）的命令跑在受限沙箱里，SAPI 的语音运行时服务
# 在那种上下文下会返回 E_ACCESSDENIED。你的终端没有这个限制。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/probe-speech.ps1
#
# 它只做四件事：编译一个临时探针 → 列出系统识别器 → 尝试建引擎/开麦克风 →
# 听 10 秒并打印识别结果。不写任何配置、不改系统设置。
#
# 注意：本文件必须以 UTF-8 with BOM 保存（PowerShell 5.1 会把无 BOM 的
# UTF-8 当 ANSI/GBK 读，中文会乱码）。
# ============================================================================
param(
  # 监听时长（秒）
  [int]$Seconds = 10
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$work = Join-Path $env:TEMP 'dsh-voice-danmaku-speech-probe'
New-Item -ItemType Directory -Force -Path $work | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$speechDll = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF\System.Speech.dll'

if (-not (Test-Path $csc))      { throw "找不到 C# 编译器: $csc" }
if (-not (Test-Path $speechDll)) { throw "找不到 System.Speech.dll: $speechDll" }

$source = Join-Path $work 'probe.cs'
$exe = Join-Path $work 'probe.exe'

# 探针源码。写成 here-string 避免引号地狱。
$code = @'
using System;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Speech.Recognition;
using System.Threading;

internal static class SpeechProbe
{
    private static int _recognized;

    [STAThread]
    private static void Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        int seconds = args.Length > 0 ? int.Parse(args[0]) : 10;

        Console.WriteLine("进程位数: " + (Environment.Is64BitProcess ? "64 位" : "32 位"));
        Console.WriteLine();

        Console.WriteLine("== 系统安装的识别器 ==");
        ReadOnlyCollection<RecognizerInfo> installed = SpeechRecognitionEngine.InstalledRecognizers();
        if (installed.Count == 0)
        {
            Console.WriteLine("  一个都没有 —— 需要在「设置 → 时间和语言 → 语音」里添加语音包");
            return;
        }
        foreach (RecognizerInfo info in installed)
        {
            Console.WriteLine("  " + info.Id + "  |  " + info.Culture + "  |  " + info.Name);
        }
        Console.WriteLine();

        // 挑中文识别器；没有就退而求其次用第一个。
        RecognizerInfo chosen = null;
        foreach (RecognizerInfo info in installed)
        {
            if (info.Culture != null &&
                info.Culture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase))
            {
                chosen = info;
                break;
            }
        }
        string mode = chosen != null ? "按 RecognizerInfo（中文）" : "无参（默认）";

        SpeechRecognitionEngine engine = null;
        string error = null;
        try
        {
            engine = chosen != null ? new SpeechRecognitionEngine(chosen) : new SpeechRecognitionEngine();
        }
        catch (Exception ex)
        {
            error = Describe(ex);
            Console.WriteLine("构造引擎失败（" + mode + "）: " + error);
            Console.WriteLine();

            // 失败后回退到无参构造再试一次：两者行为可能不同。
            try
            {
                engine = new SpeechRecognitionEngine();
                mode = "无参（默认）回退";
                Console.WriteLine("回退到无参构造: 成功");
            }
            catch (Exception ex2)
            {
                Console.WriteLine("回退也失败: " + Describe(ex2));
                Console.WriteLine();
                Console.WriteLine("结论: 这台机器上 Windows 自带的语音识别不可用。");
                return;
            }
        }

        try
        {
            Console.WriteLine("引擎: " + mode + " -> " + engine.RecognizerInfo.Name +
                " / " + engine.RecognizerInfo.Culture);
            engine.LoadGrammar(new DictationGrammar());
            Console.WriteLine("加载听写语法: 成功");
            engine.SetInputToDefaultAudioDevice();
            Console.WriteLine("打开默认麦克风: 成功");
        }
        catch (Exception ex)
        {
            Console.WriteLine("初始化失败: " + Describe(ex));
            engine.Dispose();
            Console.WriteLine();
            Console.WriteLine("结论: 引擎可创建，但无法初始化（多半是麦克风不可用或未授权）。");
            return;
        }

        ManualResetEventSlim done = new ManualResetEventSlim(false);
        engine.SpeechRecognized += delegate(object s, SpeechRecognizedEventArgs e)
        {
            Interlocked.Increment(ref _recognized);
            Console.WriteLine("  [识别] " + e.Result.Text + "   置信度=" + e.Result.Confidence.ToString("F2"));
        };
        engine.SpeechRecognitionRejected += delegate(object s, SpeechRecognitionRejectedEventArgs e)
        {
            Console.WriteLine("  [拒绝] 听到声音但没认出内容");
        };
        engine.RecognizeCompleted += delegate(object s, RecognizeCompletedEventArgs e)
        {
            if (e.Error != null) Console.WriteLine("  [结束] " + e.Error.Message);
            done.Set();
        };

        engine.RecognizeAsync(RecognizeMode.Multiple);
        Console.WriteLine();
        Console.WriteLine(">>> 请现在对麦克风说几句中文，例如「今天天气不错」 <<<");
        Console.WriteLine(">>> " + seconds + " 秒后自动结束 <<<");
        Console.WriteLine();
        done.Wait(TimeSpan.FromSeconds(seconds));

        try { engine.RecognizeAsyncStop(); } catch { }
        engine.Dispose();

        Console.WriteLine();
        if (_recognized > 0)
        {
            Console.WriteLine("结论: 可用 —— 识别到 " + _recognized + " 段内容。");
            Console.WriteLine("这条路线可以替代云端 ASR（不需要密钥、不联网、延迟更低）。");
        }
        else
        {
            Console.WriteLine("结论: 引擎与麦克风都正常，但这次没识别到内容。");
            Console.WriteLine("可能是没说够长/太小声，或识别语言与语音包不匹配。再跑一次试试。");
        }
    }

    private static string Describe(Exception ex)
    {
        try
        {
            string text = ex.GetType().Name + ": " + ex.Message;
            if (ex.InnerException != null)
            {
                text += " | 内层: " + ex.InnerException.GetType().Name + ": " + ex.InnerException.Message;
            }
            return text;
        }
        catch { return "（无法读取异常信息）"; }
    }
}
'@

# 用 UTF-8（带 BOM）写源码：csc 的 /codepage:65001 用得上，也方便人肉查看。
[System.IO.File]::WriteAllText($source, $code, (New-Object System.Text.UTF8Encoding($true)))

Write-Output "编译探针…"
& $csc /nologo /codepage:65001 /target:exe /platform:x64 /out:$exe /reference:$speechDll $source
if ($LASTEXITCODE -ne 0) { throw "编译失败（退出码 $LASTEXITCODE）" }

Write-Output "编译成功: $exe"
Write-Output ''
& $exe $Seconds
