/**
 * sidecar 子进程的协议客户端与生命周期管理。
 *
 * 职责边界：
 *   * **只管进程与字节** —— 不认识"录音""弹幕"这些业务概念；
 *   * 把入站消息按 `type` 分发给监听者，把出站消息按协议序列化；
 *   * 负责"进程死了要清理干净"——留一个抓着全局热键的孤儿进程是最糟的失败模式。
 *
 * 协议定义见 docs/protocol.md。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { error as logError, log, warn } from './logger.js';

/** sidecar 上报的热键事件。 */
export interface SidecarKeyEvent {
  /** 虚拟键码。 */
  vk: number;
  /** 可读键名，如 `F9`。 */
  key: string;
  /**
   * 事件来自哪条物理通道。
   *
   * `hook` 是低级键盘钩子（普通按键），`media` 是 `RegisterHotKey` 注册的媒体键。
   * 必须区分：两条通道可能盯着同一个键码，上层用不同的动作表查它。
   */
  source: 'hook' | 'media';
  /** `down` 或 `up`。 */
  phase: 'down' | 'up';
  /** 按住的毫秒数。只有 `up` 事件才有意义（`down` 恒为 0）。 */
  heldMs: number;
  /** 事件发生时前台窗口的 `进程名 | 标题`。 */
  foreground: string;
}

/** 浮层被用户拖动后上报的新位置。 */
export interface SidecarMovedEvent {
  x: number;
  y: number;
}

/** `configure` 消息的载荷。字段与协议一一对应。 */
export interface SidecarConfigurePayload {
  keys: string;
  /**
   * 媒体键的虚拟键码（逗号分隔）。空串表示不启用。
   *
   * 与 `keys` 是**两条独立的通道**：普通键走键盘钩子，媒体键走 `RegisterHotKey`。
   * 后者是唯一能穿过反作弊的通道，但因为媒体键被系统与其它程序共享，
   * 这里注册的键**不会被吞掉**。
   */
  mediaKeys: string;
  consumeKeys: boolean;
  fontSize: number;
  padding: number;
  marginTop: number;
  opacity: number;
  anchorXPercent: number;
  maxWidthPercent: number;
  reassertSeconds: number;
  clickThrough: boolean;
  draggable: boolean;
}

/** `show` 消息的载荷。 */
export interface SidecarShowPayload {
  text: string;
  accent?: string;
  hint?: string;
  showHint?: boolean;
  state?: string;
}

/** sidecar 回报的"实际生效配置"。用于确认配置真的送到了原生层。 */
export interface SidecarAppliedConfig {
  /** 已订阅的虚拟键码（逗号分隔）。 */
  watched: string;
  /** 已订阅键的可读名（逗号分隔）。 */
  labels: string;
  /** 实际注册成功的媒体键（逗号分隔的可读名）。 */
  mediaKeys: string;
  /**
   * 媒体键注册结果的人类可读回执，如
   * `ok=AudioVolumeMute,MediaPlayPause failed=MediaTrackNext`。
   *
   * 存在的理由：`RegisterHotKey` 失败是**静默**的（键被别的程序占用），
   * 不回报的话用户只会看到"按这个键毫无反应"，无从判断原因。
   */
  mediaKeysReport: string;
  /** 热键是否对游戏隐藏。 */
  consumeKeys: boolean;
  /** 以下为**已钳制**的实际生效值，可能与请求值不同（越界会被夹到合法区间）。 */
  fontSize: number;
  padding: number;
  marginTop: number;
  opacity: number;
  clickThrough: boolean;
  draggable: boolean;
}

/** sidecar 客户端事件表。 */
export interface SidecarClientEvents {
  /** 进程启动并且钩子就绪。`hookInstalled` 为 false 时热键一定是不可用的。 */
  ready: [{ pid: number; hookInstalled: boolean; hookError: number | null; x64: boolean }];
  /** 收到热键。 */
  key: [SidecarKeyEvent];
  /** 配置已生效，带回实际应用的值。 */
  configured: [SidecarAppliedConfig];
  /** 浮层已显示，附带"是否抢了焦点"等客观证据。 */
  shown: [Record<string, unknown>];
  /** 浮层状态变化。 */
  state: [{ state: string }];
  /** `verify` 的应答。 */
  verification: [Record<string, unknown>];
  /** 用户拖动了浮层。 */
  moved: [SidecarMovedEvent];
  /** 进程意外退出。 */
  exited: [{ code: number | null; signal: string | null; intentional: boolean }];
  /** 协议层错误或 sidecar 上报的错误。 */
  failure: [Error];
}

/** 等待某个事件，超时则抛错。用于启动握手这类"必须成功才能继续"的场合。 */
function once<T>(emitter: EventEmitter, event: string, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`等待 sidecar ${label} 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const handler = (payload: T): void => {
      clearTimeout(timer);
      emitter.off(event, handler);
      resolvePromise(payload);
    };
    emitter.once(event, handler);
  });
}

export declare interface SidecarClient {
  on<E extends keyof SidecarClientEvents>(
    event: E,
    listener: (...args: SidecarClientEvents[E]) => void
  ): this;
  once<E extends keyof SidecarClientEvents>(
    event: E,
    listener: (...args: SidecarClientEvents[E]) => void
  ): this;
  off<E extends keyof SidecarClientEvents>(
    event: E,
    listener: (...args: SidecarClientEvents[E]) => void
  ): this;
  emit<E extends keyof SidecarClientEvents>(event: E, ...args: SidecarClientEvents[E]): boolean;
}

/** sidecar 的客户端句柄。 */
export class SidecarClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = '';
  private readonly pending = new Map<string, (message: Record<string, unknown>) => void>();
  private requestSeq = 0;
  private stopping = false;
  /**
   * 用户是否从托盘菜单要求过退出。
   *
   * 这决定"要不要自动重启"。主程序有崩溃自愈，但**用户明确的退出不能被自愈覆盖**
   * ——否则表现就是"点了退出它又自己冒出来，根本关不掉"（实测踩到过）。
   * 所以 sidecar 用 `bye` 消息里的 `intentional` 字段告诉我们退出原因。
   */
  private userRequestedExit = false;

  /**
   * 启动 sidecar 并等待它就绪。
   *
   * @param exePath - sidecar 可执行文件路径。
   * @param readyTimeoutMs - 等待 `ready` 消息的上限。首次启动时 Windows 可能要
   *   加载 .NET 运行时，给得宽一点。
   * @throws 启动失败、进程立刻退出、或钩子安装失败时抛错——这三种情况继续下去
   *   都没有意义（插件会变成一个"按了没反应"的东西，比明确报错更难排查）。
   */
  async start(exePath: string, readyTimeoutMs = 15000): Promise<void> {
    if (this.child !== undefined) throw new Error('sidecar 已经在运行');

    this.stopping = false;
    // 把本进程 pid 交给 sidecar：它据此在我被强杀时自行退出，
    // 避免留下抓着全局热键不放的孤儿进程。
    const child = spawn(exePath, ['--parent-pid', String(process.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) warn('sidecar stderr:', text);
    });

    child.on('error', (cause) => {
      this.emit('failure', new Error(`无法启动 sidecar: ${cause.message}`));
    });

    child.on('exit', (code, signal) => {
      this.child = undefined;
      // 主动停止、或用户点托盘"退出"，都是预期结果，不该触发自愈重启。
      // 后者尤其重要：不区分的话，用户点了退出会被自动重启，表现为"关不掉"。
      if (this.stopping || this.userRequestedExit) {
        if (this.userRequestedExit) log('sidecar 已按用户要求退出，不会自动重启');
        this.emit('exited', { code, signal, intentional: true });
        return;
      }
      const detail = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
      logError(`sidecar 意外退出（${detail}）`);
      this.emit('exited', { code, signal, intentional: false });
    });

    const ready = await once<SidecarClientEvents['ready'][0]>(this, 'ready', readyTimeoutMs, 'ready');
    if (!ready.hookInstalled) {
      throw new Error(
        `sidecar 已启动但全局键盘钩子安装失败（Win32 错误码 ${ready.hookError ?? '未知'}）。` +
        '热键无法工作。这通常意味着另一个程序正在以更高权限拦截输入，' +
        '或者 sidecar 以 32 位运行在 64 位系统上。'
      );
    }
    log(`sidecar 就绪 pid=${ready.pid} x64=${ready.x64}`);
  }

  /** 是否正在运行。 */
  get running(): boolean {
    return this.child !== undefined;
  }

  /** 按当前设置下发配置。可随时重复调用，sidecar 不停机。 */
  configure(payload: SidecarConfigurePayload): void {
    this.send({ type: 'configure', id: this.nextId('cfg'), ...payload });
  }

  /** 显示浮层。 */
  show(payload: SidecarShowPayload): void {
    this.send({
      type: 'show',
      id: this.nextId('show'),
      text: payload.text,
      accent: payload.accent,
      hint: payload.hint,
      showHint: payload.showHint ?? true,
      state: payload.state ?? 'shown'
    });
  }

  /** 隐藏浮层。 */
  hide(): void {
    this.send({ type: 'hide', id: this.nextId('hide') });
  }

  /**
   * 让 sidecar 播放一串提示音（`频率:毫秒`，逗号分隔，如 `880:90,660:90`）。
   *
   * 为什么这件事交给 sidecar，而不是在主程序里
   * `spawn('powershell.exe', ['-Command', '[console]::beep(...)'])`：
   * 那样**每按一次键就会启动一个 powershell 进程** —— 而 powershell 的启动是
   * 恶意软件的高频特征，安全软件会对它格外上心。这个工具只是想"嘀"一声，
   * 没有任何理由把 powershell 牵扯进来。sidecar 是常驻原生进程，零开销、更快。
   */
  beep(tones: string): void {
    if (tones.trim().length === 0) return;
    this.send({ type: 'beep', tones });
  }

  /** 请求一次浮层物理状态自检，结果通过 `verification` 事件返回。 */
  verify(): void {
    this.send({ type: 'verify', id: this.nextId('verify') });
  }

  /**
   * 优雅停止：先发 shutdown 让 sidecar 自己收钩子，超时再强杀。
   * 强杀是兜底，因为挂在链上的钩子不摘掉会影响整个会话的输入。
   */
  async stop(timeoutMs = 1500): Promise<void> {
    const child = this.child;
    if (child === undefined) return;

    this.stopping = true;
    const exited = new Promise<void>((resolvePromise) => {
      child.once('exit', () => resolvePromise());
    });

    try {
      this.send({ type: 'shutdown' });
    } catch {
      /* 管道可能已经断了，直接进入强杀兜底 */
    }

    const timeout = new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, timeoutMs);
    });
    await Promise.race([exited, timeout]);

    if (this.child !== undefined) {
      warn('sidecar 未在超时内退出，强制结束');
      child.kill();
      this.child = undefined;
    }
  }

  /** 收到的一段 stdout 数据，按换行切分后逐条处理。 */
  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.dispatch(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // sidecar 也可能把原生库的杂音写到 stdout；只警告，不断连。
      warn('sidecar 输出了非 JSON 内容:', line.slice(0, 200));
      return;
    }

    const type = typeof message.type === 'string' ? message.type : '';
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id !== undefined) {
      const resolve = this.pending.get(id);
      if (resolve !== undefined) {
        this.pending.delete(id);
        resolve(message);
      }
    }

    switch (type) {
      case 'ready':
        this.emit('ready', {
          pid: Number(message.pid ?? 0),
          hookInstalled: message.hookInstalled === true,
          hookError: typeof message.hookError === 'number' ? message.hookError : null,
          x64: message.x64 === true
        });
        break;
      case 'key':
        this.emit('key', {
          vk: Number(message.vk ?? 0),
          key: String(message.key ?? ''),
          source: message.source === 'media' ? 'media' : 'hook',
          phase: message.phase === 'up' ? 'up' : 'down',
          heldMs: Number(message.heldMs ?? 0),
          foreground: String(message.foreground ?? '')
        });
        break;
      case 'configured':
        this.emit('configured', {
          watched: String(message.watched ?? ''),
          labels: String(message.labels ?? ''),
          mediaKeys: String(message.mediaKeys ?? ''),
          mediaKeysReport: String(message.mediaKeysReport ?? ''),
          consumeKeys: message.consumeKeys === true,
          fontSize: Number(message.fontSize ?? 0),
          padding: Number(message.padding ?? 0),
          marginTop: Number(message.marginTop ?? 0),
          opacity: Number(message.opacity ?? 0),
          clickThrough: message.clickThrough === true,
          draggable: message.draggable === true
        });
        break;
      case 'shown':
        this.emit('shown', message);
        break;
      case 'state':
        this.emit('state', { state: String(message.state ?? '') });
        break;
      case 'verification':
        this.emit('verification', message);
        break;
      case 'moved':
        this.emit('moved', { x: Number(message.x ?? 0), y: Number(message.y ?? 0) });
        break;
      case 'error':
        this.emit('failure', new Error(`sidecar 报错: ${String(message.message ?? '未知')}`));
        break;
      case 'bye':
        // sidecar 即将退出。它会在 intentional=true 时告诉我们"这是用户从托盘
        // 点的退出"，据此抑制自动重启。注意这个消息可能早于 close/exit 到达，
        // 所以在这里就把标记立起来。
        //
        // ⚠️ 必须排除 `stopping`：我们自己调 `stop()` 让它退出时，它**同样**会报
        // `intentional: true`（从 sidecar 的视角，"收到退出指令"就是主动退出）。
        // 不排除的话，插件每次卸载都会打一句"sidecar 已按用户要求退出" —— 排查
        // "点启动没反应"时我被这句话带偏过一次，误以为是你手动关的。
        if (message.intentional === true && !this.stopping) this.userRequestedExit = true;
        break;
      case 'pong':
        break;
      default:
        warn('收到未知类型的 sidecar 消息:', type);
        break;
    }
  }

  /** 写一条协议消息。进程不在时静默丢弃——调用方不需要处理"正在退出"的竞态。 */
  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (child === undefined) return;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (cause) {
      logError('向 sidecar 发送消息失败:', cause);
    }
  }

  private nextId(prefix: string): string {
    this.requestSeq += 1;
    return `${prefix}-${this.requestSeq}`;
  }
}
