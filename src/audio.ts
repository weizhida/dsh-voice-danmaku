/**
 * 麦克风录音。
 *
 * ## 为什么需要一个外部后端
 *
 * DSH 宿主是 Node 进程，Node 没有任何内置的音频采集 API。要在 Windows 上拿到
 * 麦克风的 PCM 数据，只有三条路：
 *
 *   1. 原生模块（如 `naudiodon`）—— 需要编译工具链，安装门槛高；
 *   2. 调 Windows 原生 API（waveIn / WASAPI）—— 需要额外写一个采样子进程；
 *   3. 调用一个已存在的、几乎人人机器上都有的命令行录音工具。
 *
 * 当前实现走第 3 条：**ffmpeg**。理由是零编译、零额外二进制、行为可预测，
 * 而且 ffmpeg 是录屏/直播人群本来就装的东西。
 *
 * 这个选择是**可替换的**：只要实现 `AudioRecorder` 接口并改 `createRecorder`
 * 的注册表即可切换到原生采集，业务层完全不受影响。
 *
 * ## 采集参数的选择
 *
 * 16 kHz / 单声道 / 16-bit PCM 是语音识别模型的通用输入格式。
 * 直接在采集端就转成这个格式，省掉后面重采样，也避免把 48 kHz 立体声
 * 白白上传（体积是 6 倍，且识别精度不会更好）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { error as logError, log, warn } from './logger.js';

/** 录音器接口。 */
export interface AudioRecorder {
  /** 后端标识，用于日志与配置。 */
  readonly id: string;
  /** 探测后端在当前机器上是否可用；不可用时返回原因。 */
  probe(): Promise<ProbeResult>;
  /**
   * 开始采集。重复调用应抛错。
   *
   * 返回的 Promise 在**设备真的开始输出数据**之后才 resolve —— 调用方要等它，
   * 因为"提示音该什么时候响"完全取决于这件事（见实现里的说明）。
   */
  start(): Promise<void>;
  /** 停止采集并返回 WAV 数据。 */
  stop(): Promise<Uint8Array>;
  /** 立即丢弃当前采集并释放资源。 */
  abort(): void;
}

/** 后端可用性探测结果。 */
export interface ProbeResult {
  available: boolean;
  /** 不可用或可用时的补充说明。 */
  detail: string;
}

/** 采集格式。语音识别的通用输入，不在采集端之外的任何地方假定别的格式。 */
export const SAMPLE_RATE = 16000;
const CHANNELS = 1;

/**
 * 基于 ffmpeg 的录音后端。
 *
 * 用**管道**取数据（输出 wav 到 stdout）而不是写临时文件：
 * 少一次磁盘往返、不留下含语音的残留文件、也不依赖临时目录的清理。
 */
export class FfmpegRecorder implements AudioRecorder {
  readonly id = 'ffmpeg';

  private child: ChildProcess | undefined;
  private chunks: Buffer[] = [];
  private stderrTail = '';
  private stopped: Promise<Uint8Array> | undefined;
  /** 第一块音频数据到达（= 设备真的开始采了）。见 start() 的说明。 */
  private firstChunk: Promise<void> | undefined;

  /**
   * @param ffmpegPath - ffmpeg 可执行文件。
   * @param deviceName - dshow 设备名，必须与 `ffmpeg -list_devices` 报出的**逐字一致**
   *   （例如「麦克风」）。dshow 不接受 `default` 这种写法，所以这个值必须解析得到。
   */
  constructor(
    private readonly ffmpegPath: string,
    private readonly deviceName: string
  ) {}

  /** 检查 ffmpeg 是否存在且能报出版本。 */
  async probe(): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolvePromise) => {
      const child = spawn(this.ffmpegPath, ['-version'], { windowsHide: true });
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('error', (cause) => {
        resolvePromise({
          available: false,
          detail: `无法运行 ffmpeg（${this.ffmpegPath}）：${cause.message}`
        });
      });
      child.on('close', (code) => {
        if (code === 0) {
          const firstLine = output.split(/\r?\n/)[0] ?? '';
          resolvePromise({ available: true, detail: firstLine.trim() });
          return;
        }
        resolvePromise({ available: false, detail: `ffmpeg 退出码 ${code}` });
      });
    });
  }

  /**
   * 开始采集，**等真正有音频数据了才返回**。
   *
   * ## 为什么必须等（这一条是实测换来的）
   *
   * `spawn` 只是把进程拉起来；ffmpeg 还要初始化 DirectShow 设备才真正开始读
   * 麦克风，实测要几百毫秒。在这段时间里说出去的话**是录不到的**。
   *
   * 而调用方（状态机）的流程是「等 startRecording() → 响提示音 → 用户开口」。
   * 第一版 `start()` 一 spawn 就返回，于是提示音在"其实还没开始录"的时候响了，
   * 用户听到就说话 —— 说两三个字（半秒左右）的人，话全落在了设备初始化里，
   * 表现就是"说完了什么都没识别到"。
   *
   * 把就绪点对齐到"第一块数据真的到了"，提示音才代表"现在可以说了"。
   *
   * @param timeoutMs - 兜底：设备异常时不会有数据，不能永远卡住。
   */
  async start(timeoutMs = 2000): Promise<void> {
    if (this.child !== undefined) throw new Error('录音已经在进行中');

    this.chunks = [];
    this.stderrTail = '';
    this.stopped = undefined;
    this.firstChunk = undefined;

    // 设备名必须与 `ffmpeg -list_devices` 报出的名字**逐字一致**。
    // dshow 不支持 `audio=default` 这种写法 —— 用它一定失败。
    // 所以这里要求调用方先解析出设备名（见 audio.ts 的 enumerateAudioDevices）。
    if (this.deviceName.trim().length === 0) {
      throw new Error('没有指定录音设备名。dshow 需要用确切设备名，不能写 default。');
    }

    // 参数说明：
    //   -f dshow             Windows 的 DirectShow 采集
    //   -i audio=<设备名>     确切设备名，如「麦克风」
    //   -ac / -ar / -f s16le  单声道 / 16 kHz / 有符号 16 位小端 PCM
    //   -                  输出到 stdout
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-i', `audio=${this.deviceName}`,
      '-ac', String(CHANNELS),
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      '-'
    ];

    const child = spawn(this.ffmpegPath, args, {
      // stdin 必须是管道：停止录音时往它写 'q' 让 ffmpeg 自己收尾
      // （见 stop() 里关于为什么不能只关 stdin 的说明）。
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;

    let ready: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolvePromise) => {
      ready = resolvePromise;
    });
    this.firstChunk = firstChunk;

    const timer = setTimeout(() => {
      // 超时也放行：录不到数据时该由 stop() 去报错，不该让状态机卡在"录音中"。
      warn(`ffmpeg 在 ${timeoutMs}ms 内没有输出音频数据，仍然继续（可能是设备被占用）`);
      ready?.();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      clearTimeout(timer);
      // 第一块数据到达 = 设备已经在真的采了。这时候才算"开始录音"。
      ready?.();
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // 只留尾部：ffmpeg 在设备打不开时会刷很多行，全部保留没意义。
      this.stderrTail = (this.stderrTail + chunk).slice(-800);
    });

    child.on('error', (cause) => {
      logError('ffmpeg 启动失败:', cause);
      clearTimeout(timer);
      ready?.();
    });

    child.on('close', (code) => {
      this.child = undefined;
      clearTimeout(timer);
      ready?.();
      if (code !== 0 && code !== null) {
        logError(`ffmpeg 异常退出（码 ${code}）: ${this.stderrTail.trim()}`);
      }
    });

    await firstChunk;
    log('录音已就绪（设备开始输出数据）');
  }

  /**
   * 停止采集并返回 WAV。
   *
   * 注意实现细节：ffmpeg 收到 `q` 或关闭 stdin 才会优雅收尾并冲刷剩余数据。
   * 我们不用 SIGKILL —— 那会丢掉最后几百毫秒，而那恰好是你刚说完的那句话。
   */
  async stop(): Promise<Uint8Array> {
    if (this.stopped !== undefined) return this.stopped;

    const child = this.child;
    if (child === undefined) throw new Error('没有正在进行的录音');

    this.stopped = new Promise<Uint8Array>((resolvePromise, reject) => {
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;

        // 先把缓冲拼出来再判空：ffmpeg 是被强杀的情况下，close 事件仍会到，
        // 而这时缓冲区里已经是我们录到的全部数据，不能当失败丢掉。
        const pcm = Buffer.concat(this.chunks);
        this.chunks = [];
        this.child = undefined;

        if (pcm.length === 0) {
          reject(new Error(
            '没有采集到音频数据。可能是麦克风被占用、没有录音设备，或系统未授权麦克风访问。' +
            (this.stderrTail.trim().length > 0 ? ` ffmpeg 输出：${this.stderrTail.trim()}` : '')
          ));
          return;
        }
        resolvePromise(wrapWav(pcm, SAMPLE_RATE, CHANNELS));
      };

      child.once('close', finish);
      child.once('error', (cause) => {
        if (settled) return;
        settled = true;
        this.child = undefined;
        reject(new Error(`ffmpeg 出错：${cause.message}`));
      });

      /**
       * 让 ffmpeg 尽快停下来。
       *
       * **这里不能只关 stdin。** 第一版以为关掉 stdin 会让 ffmpeg 优雅收尾，
       * 实测（ffmpeg 9.0.2 + dshow）它不会退出——必须等到 2 秒兜底强杀。
       * 后果是每次停止录音都有 2 秒延迟，而"按一下结束、马上看到识别结果"
       * 是这个工具最核心的手感。
       *
       * 所以先发 'q'（ffmpeg 交互式的标准退出键），给它 250ms 自己收尾；
       * 不听话就 SIGTERM。SIGTERM 之后 close 事件照样会到，缓冲区里的音频
       * 已经拿到手了，不会丢。
       */
      try {
        child.stdin?.write('q');
      } catch {
        /* stdin 可能已经不可写 */
      }

      const gentle = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGTERM'); } catch { /* 可能已经退出 */ }
      }, 250);

      // 最后的兜底：连 SIGTERM 都不认就强杀。到这一步说明进程真的卡住了。
      setTimeout(() => {
        if (settled) return;
        logError('ffmpeg 未在 1 秒内退出，强制结束');
        try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      }, 1000);

      child.once('close', () => clearTimeout(gentle));
    });

    return this.stopped;
  }

  abort(): void {
    const child = this.child;
    this.child = undefined;
    this.chunks = [];
    if (child !== undefined) {
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
    }
  }
}

/**
 * 给裸 PCM 套上 WAV 头。
 *
 * 为什么要包 WAV 而不是直接传裸 PCM：几乎所有 OpenAI 兼容的转写接口都按
 * 文件名/容器嗅探格式，裸 PCM 没有自描述信息，会被当成损坏的音频。
 */
function wrapWav(pcm: Buffer, sampleRate: number, channels: number): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);   // 文件总长度 - 8
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);               // fmt 块长度
  header.writeUInt16LE(1, 20);                // 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return new Uint8Array(Buffer.concat([header, pcm]));
}

/**
 * 录音后端注册表。
 *
 * 加一个新后端（例如基于 waveIn 的原生采集）= 实现 `AudioRecorder` + 在这里登记。
 * 业务层只认接口，不认识 ffmpeg。
 */
export function createRecorder(options: { ffmpegPath: string; deviceName: string }): AudioRecorder {
  return new FfmpegRecorder(options.ffmpegPath, options.deviceName);
}

/**
 * 解析 `ffmpeg -list_devices true -f dshow -i dummy` 的输出，取出音频设备名。
 *
 * ## 为什么必须做这一步
 *
 * 第一版把录音命令写成 `-i audio=default`，这是**错的**：dshow 不接受 `default`
 * 这个设备名，必须用确切名字（如「麦克风」）。所以"能不能录音"完全取决于有没有
 * 解析出真实设备名 —— 这个 bug 会让录音在任何机器上都失败。
 *
 * ffmpeg 把设备清单写到 **stderr**，格式是两类行：
 *     [in#0 @ ...] "麦克风" (audio)
 *     [in#0 @ ...]   Alternative name "@device_cm_..."
 * 所以我们取带 `(audio)` 的引号名，忽略 `(video)` 和 Alternative name。
 *
 * @param output - ffmpeg 的 stderr 文本。
 * @returns 音频设备名列表（保持 ffmpeg 给出的顺序）。
 */
export function parseAudioDeviceNames(output: string): string[] {
  const names: string[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    // 只认以 (audio) 结尾的设备行 —— "（audio）" 这种全角形式 ffmpeg 不会输出。
    if (!/\(audio\)\s*$/.test(line.trim())) continue;
    // 设备名在最后一对英文双引号里。名字本身可能含引号或空格，所以从末尾往前找。
    const match = /"([^"]*)"\s*\(audio\)\s*$/.exec(line.trim());
    // match[1] 在类型上是 string | undefined（noUncheckedIndexedAccess），
    // 但上面的正则捕获组必然存在；用 ?? '' 兜住类型而不改变行为。
    const name = (match?.[1] ?? '').trim();
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 设备枚举结果。 */
export interface AudioDeviceEnumeration {
  /** 可用的音频输入设备名。 */
  devices: string[];
  /** ffmpeg 的原始输出片段，枚举失败时用来诊断。 */
  raw: string;
}

/**
 * 枚举 DirectShow 的音频输入设备。
 * @param ffmpegPath - ffmpeg 可执行文件。
 * @param timeoutMs - 超时；ffmpeg 列设备后不会自己退出（因为 dummy 输入打不开），
 *   所以必须靠超时收尾。
 */
export function enumerateAudioDevices(
  ffmpegPath: string,
  timeoutMs = 5000
): Promise<AudioDeviceEnumeration> {
  return new Promise<AudioDeviceEnumeration>((resolvePromise) => {
    let output = '';
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    // 设备清单走 stderr —— 这是 ffmpeg 的固定行为，不是我们的选择。
    child.stderr?.on('data', collect);

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 可能已经退出 */ }
      resolvePromise({ devices: parseAudioDeviceNames(output), raw: output });
    };

    child.on('error', finish);
    child.on('close', finish);
    // ffmpeg 列出设备后会卡在"打不开 dummy"，不会自己退出，所以必须有超时。
    setTimeout(finish, timeoutMs);
  });
}
