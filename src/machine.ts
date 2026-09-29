/**
 * 交互状态机。
 *
 * 这是插件的业务核心，也是唯一一处"什么时候该发生什么"的定义。
 * 它**刻意不碰任何 I/O**：录音、识别、发送、浮层全部通过 `deps` 注入。
 * 因此它可以被纯逻辑单测覆盖，而不需要麦克风、不需要网络、不需要 Windows。
 *
 * 状态迁移：
 *
 *         F9                F9                 转写完成
 *   idle ─────► recording ─────► transcribing ─────────► confirm
 *     ▲              │                  │                   │
 *     │              │ F11 取消 / 录音失败│ 转写失败           │ F10 发送
 *     │              ▼                  ▼                   ▼
 *     └──────────── idle ◄─────────────┘                sending
 *                                                          │
 *                                                          ▼
 *                                                     idle（成败皆回）
 */

/** 机器状态。 */
export type MachineState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'confirm'
  | 'sending';

/** 浮层该显示什么。`deps.overlay` 只接收这个结构，不接触机器内部。 */
export interface OverlayView {
  text: string;
  accent: string;
  hint: string;
  showHint: boolean;
}

/** 状态机需要的全部外部能力。 */
export interface MachineDeps {
  /** 开始录音。 */
  startRecording(): Promise<void>;
  /** 停止录音并返回音频数据。 */
  stopRecording(): Promise<Uint8Array>;
  /** 把音频转写成文字。 */
  transcribe(audio: Uint8Array): Promise<string>;
  /**
   * 发送一条弹幕。
   *
   * * **失败**：抛异常，由状态机统一转成用户可见的反馈；
   * * **结果未知**（请求可能已经出去了，但没拿到确认）：返回 `{ unsure: true }`。
   *   状态机会据此锁住输入 —— 当成失败会让用户重试，而重试可能发出**两条**。
   */
  send(text: string): Promise<{ unsure: true; reason: string } | void>;
  /** 更新浮层。传 null 表示隐藏。 */
  overlay(view: OverlayView | null): void;
  /** 播放一个反馈音。 */
  sound(kind: 'start' | 'stop' | 'confirm' | 'sent' | 'error'): void;
  /** 一条用户可见的状态说明，写进日志或未来的界面提示。 */
  notify(message: string, level: 'info' | 'warn' | 'error'): void;
}

/** 运行时参数。每次热键按下时读取，因此改设置立即生效。 */
export interface MachineOptions {
  /** 是否用声音反馈。 */
  soundFeedback: boolean;
  /** 识别完成后是否直接发送。 */
  autoSend: boolean;
  /** 弹幕长度上限。 */
  maxLength: number;
  /** 确认窗口自动取消的秒数；0 表示不自动取消。 */
  confirmTimeoutSeconds: number;
}

/** 各状态的浮层配色。让状态一眼可辨，不用读文字。 */
const ACCENT = {
  recording: '#EF4444',   // 红：正在录，你正在被听见
  transcribing: '#F59E0B', // 琥珀：在处理，等一下
  confirm: '#3B82F6',      // 蓝：等你按键，这是唯一需要你动作的状态
  sending: '#8B5CF6',      // 紫：正在发
  sent: '#10B981',         // 绿：成功
  failed: '#EF4444',       // 红：失败
  // 琥珀：**结果未知**。刻意不用红 —— 红色读作"失败了，再来一次"，
  // 而这个状态不是失败，它只是"不知道"。用同样的红会诱导用户重发。
  unknown: '#F59E0B'
} as const;

/** 成功/失败提示在浮层上停留的时长。 */
const TRANSIENT_MS = 1200;

/**
 * 错误类提示的停留时长。
 *
 * 为什么比成功提示长这么多：用户的眼睛在游戏上，一次抬眼看屏幕的窗口只有一两秒。
 * "✓ 已发送"不需要读什么，1.2 秒够用；而"识别失败：账户余额不足，请到服务商控制台
 * 充值"必须让他读完 —— 否则他会以为插件坏了，而不是去充值。
 */
const ERROR_TRANSIENT_MS = 4500;

/**
 * 句末标点。
 *
 * 直播间弹幕的习惯是**不写句末标点**：语音识别出来是「今天天气不错。」，
 * 而真人发弹幕会写「今天天气不错」。
 *
 * 刻意**不包括括号和引号**：它们是成对的，删掉右半边比留着更难看
 * （「好耶（笑）」会变成「好耶（笑」）。
 */
const TRAILING_PUNCTUATION = /[\s。，、！？；：.,!?;:…~～·]+$/u;

/** 去掉句末的标点（可能连着好几个）。只动末尾，中间的标点原样保留。 */
function stripTrailingPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCTUATION, '');
}

export class VoiceDanmakuMachine {
  private current: MachineState = 'idle';
  private pendingText = '';
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private transientTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: MachineDeps,
    private readonly options: () => MachineOptions
  ) {}

  /** 当前状态。 */
  get state(): MachineState {
    return this.current;
  }

  /** 当前待确认文本（没有则为空串）。 */
  get pending(): string {
    return this.pendingText;
  }

  /**
   * 处理一次热键按下。
   *
   * 这是唯一的公开入口：所有交互都由这几个键驱动，没有别的路径。
   * 未知键被忽略（不会有"意外触发了什么"的可能）。
   *
   * @param action - 已由调用方按配置解析好的语义动作。
   */
  async handleKey(action: 'record' | 'send' | 'cancel'): Promise<void> {
    this.clearTransient();

    if (action === 'record') {
      await this.onRecordKey();
      return;
    }
    if (action === 'cancel') {
      this.onCancelKey();
      return;
    }
    await this.onSendKey();
  }

  /** 停止并释放定时器。插件卸载时必须调用，否则定时器会拖住进程。 */
  dispose(): void {
    this.clearConfirmTimer();
    this.clearTransient();
  }

  // -------------------------------------------------------------------------
  // 各按键的处理
  // -------------------------------------------------------------------------

  private async onRecordKey(): Promise<void> {
    switch (this.current) {
      case 'recording':
        await this.finishRecording();
        return;
      case 'confirm':
        // 在确认状态下按录音键 = "这条不对，我重说"，直接重新开始。
        this.deps.notify('放弃上一段识别结果，重新录音', 'info');
        this.toIdle();
        await this.beginRecording();
        return;
      case 'transcribing':
      case 'sending':
        this.deps.notify('正在处理上一条，请稍候', 'warn');
        return;
      case 'idle':
        await this.beginRecording();
        return;
    }
  }

  /**
   * 取消键：**纯粹的取消**。
   *
   * 它曾经在文本超长时"改为截断"（把唯一的那个键变成此刻最有用的操作）。
   * 那条复用已经撤掉了 —— 现在超长会在**进确认框时**就自动截断，所以根本不会
   * 出现"挂在半空中等着被截断"的文本。留着它只会造成一个很糟的误解：
   * 用户按 F11 想放弃这条，结果话被砍了一半还留在屏幕上。
   *
   * （媒体键的取消走的是同一个入口，所以这里改一次两边都生效。）
   */
  private onCancelKey(): void {
    if (this.current === 'idle') return;

    this.deps.notify('已取消', 'info');
    this.toIdle();
  }

  private async onSendKey(): Promise<void> {
    if (this.current !== 'confirm') {
      // 不在确认状态时按发送键是空操作。不报错——游戏里误按是常事，
      // 不值得为它打断用户。
      return;
    }
    if (this.pendingText.length === 0) {
      this.deps.notify('没有可发送的内容', 'warn');
      this.toIdle();
      return;
    }

    this.clearConfirmTimer();
    // 确认框里显示的就是要发出去的内容（超长在进框时就截掉了），所以这里
    // 不再做长度判断 —— **让服务端去裁决**。本地拦下来只会白丢一条消息，
    // 而服务端拒绝时给的理由比我们猜的准。
    //
    // 保留一次防御性截断：用户可能在确认框挂着的时候去设置里把上限调小了。
    const text = this.pendingText.slice(0, this.maxLength());
    this.current = 'sending';
    this.deps.overlay(this.sendingView(text));

    try {
      const outcome = await this.deps.send(text);

      // **结果未知**：不报失败，也不报成功 —— 如实说"不知道"，然后收工。
      //
      // ## 为什么不报失败
      //
      // 报失败等于在暗示"该重试"。用户会重说一遍再发一次，而这条**可能已经
      // 发出去了** —— 直播间里就是两条一模一样的话。而"同一句话短时间发两遍"
      // 恰恰是最像机器人的特征，是真正会招风控的行为。
      //
      // ## 为什么也不需要任何"锁定 / 解锁"
      //
      // 这条文本**直接丢弃**：项目里根本没有"重发上一条"这个动作。用户想再发，
      // 只能重新说一遍 —— 那是一个需要他主动做的决定，不是被一个失败提示诱导的。
      // 既然没有可重发的对象，就不需要锁住什么；把话说清楚，回到空闲即可。
      if (outcome !== undefined && outcome.unsure === true) {
        this.deps.sound('error');
        this.showTransient('⚠ 结果未知', '请到直播间确认这条有没有发出去', ACCENT.unknown, ERROR_TRANSIENT_MS);
        this.pendingText = '';
        this.current = 'idle';
        this.deps.notify(
          `发送结果未知（${outcome.reason}）。这条弹幕可能发出去了、也可能没有，` +
          '请自行到直播间确认。',
          'warn'
        );
        return;
      }

      this.deps.sound('sent');
      this.showTransient('✓ 已发送', text, ACCENT.sent);
      this.pendingText = '';
      this.current = 'idle';
      this.deps.notify(`已发送：${text}`, 'info');
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.deps.sound('error');
      this.showTransient('✗ 发送失败', reason, ACCENT.failed, ERROR_TRANSIENT_MS);
      this.pendingText = '';
      this.current = 'idle';
      this.deps.notify(`发送失败：${reason}`, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // 录音与转写
  // -------------------------------------------------------------------------

  private async beginRecording(): Promise<void> {
    try {
      await this.deps.startRecording();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.toIdle();
      this.deps.notify(`无法开始录音：${reason}`, 'error');
      return;
    }
    this.current = 'recording';
    this.deps.sound('start');
    this.deps.overlay({
      text: '● 正在听…',
      accent: ACCENT.recording,
      hint: '再按一次结束',
      showHint: true
    });
  }

  private async finishRecording(): Promise<void> {
    this.deps.sound('stop');
    this.current = 'transcribing';
    this.deps.overlay({
      text: '⋯ 识别中…',
      accent: ACCENT.transcribing,
      hint: '',
      showHint: false
    });

    let audio: Uint8Array;
    try {
      audio = await this.deps.stopRecording();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.toIdle();
      this.deps.notify(`录音结束失败：${reason}`, 'error');
      return;
    }

    let text: string;
    try {
      text = (await this.deps.transcribe(audio)).trim();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.toIdle();
      // **必须在浮层上说，不能只写日志。**
      //
      // 第一版这里只有 notify（日志），于是用户看到的现象是"说完话浮层就没了，
      // 什么也没发生"—— 他无从知道是余额不足、密钥失效还是网络不通，更不会去翻日志。
      // 欠费正是这种情况：真正该做的事（充值）在日志里，而他永远看不到。
      this.showTransient('✗ 识别失败', reason, ACCENT.failed, ERROR_TRANSIENT_MS);
      this.deps.notify(`识别失败：${reason}`, 'error');
      return;
    }

    // 去掉句末标点，**在显示给用户之前**做。
    //
    // 为什么在这一步而不是发送时：用户看到的必须就是将要发出去的东西。
    // 等他确认之后再偷偷改掉，那是另一种"软件自作主张"。
    text = stripTrailingPunctuation(text);

    // **超长也在这里截断**，同样是为了"看到的就是会发出去的"。
    //
    // 确认框里只放截断后的内容，被删掉的那截不显示 —— 显示一个不会发出去的东西
    // 没有意义，还会让人以为整句都发出去了。截断这件事本身要告诉他（见 confirmView），
    // 但只通知"截断了"，不展示截掉的是什么。
    this.truncated = text.length > this.maxLength();
    if (this.truncated) text = text.slice(0, this.maxLength());

    if (text.length === 0) {
      // 空结果通常是没说话、说得太短，或者麦克风没收到声音。
      // 不弹确认框（一个空框只会让人困惑），但**必须给一句话** ——
      // 用户的原话是"经常说完都不识别"，而当时界面上什么都没有，
      // 他无法判断是没录到、识别成空、还是插件坏了。
      this.toIdle();
      this.showTransient('没有听到声音', '可能说得太短，或麦克风没收到 · 再试一次', ACCENT.unknown);
      this.deps.notify('没有识别到内容', 'warn');
      return;
    }

    this.pendingText = text;
    this.current = 'confirm';
    this.deps.sound('confirm');

    if (this.options().autoSend) {
      this.deps.notify('已按设置自动发送', 'info');
      await this.onSendKey();
      return;
    }

    this.deps.overlay(this.confirmView());
    this.armConfirmTimer();
  }

  // -------------------------------------------------------------------------
  // 视图与定时器
  // -------------------------------------------------------------------------

  private maxLength(): number {
    return this.options().maxLength;
  }

  /**
   * 这次识别结果是不是被截断过。
   *
   * 只用来**说明"截断发生过"**，不保存被截掉的内容 —— 那截不会发出去，
   * 留着它只会诱使人把它显示出来。
   */
  private truncated = false;

  private confirmView(): OverlayView {
    // 框里的 `text` 已经是截断后的内容（进框前就截好了），所以这里只需**说明**
    // 截断发生过 —— 不展示被删掉的那截，因为它不会发出去，显示它没有意义。
    const hint = this.truncated
      ? `⚠ 太长，已截断到 ${this.maxLength()} 字 · 确认发送 · 取消 · 重说`
      : `${this.pendingText.length}/${this.maxLength()} 字 · 确认发送 · 取消 · 重说`;
    return {
      text: this.pendingText,
      accent: this.truncated ? ACCENT.unknown : ACCENT.confirm,
      hint,
      showHint: true
    };
  }

  private sendingView(text: string): OverlayView {
    return { text, accent: ACCENT.sending, hint: '正在发送…', showHint: true };
  }

  /**
   * 临时提示（发送成功/失败、识别失败…），到点自动隐藏。
   *
   * @param durationMs - 停留时长。**错误提示必须比成功提示长**，原因见
   *   `ERROR_TRANSIENT_MS` 的说明：用户的眼神在游戏上，读不完就消失了。
   */
  private showTransient(
    title: string,
    body: string,
    accent: string,
    durationMs: number = TRANSIENT_MS
  ): void {
    this.clearTransient();
    this.deps.overlay({ text: title, accent, hint: body, showHint: true });
    this.transientTimer = setTimeout(() => {
      this.transientTimer = undefined;
      this.deps.overlay(null);
    }, durationMs);
  }

  /**
   * 装上确认窗口的自动取消定时器。
   * 游戏里手一忙就会忘记它还挂着，不自动收尾迟早会误按发送。
   */
  private armConfirmTimer(): void {
    this.clearConfirmTimer();
    const seconds = this.options().confirmTimeoutSeconds;
    if (seconds <= 0) return;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = undefined;
      if (this.current !== 'confirm') return;
      this.toIdle();
      this.deps.notify(`${seconds} 秒无操作，已自动取消`, 'info');
    }, seconds * 1000);
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== undefined) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = undefined;
    }
  }

  private clearTransient(): void {
    if (this.transientTimer !== undefined) {
      clearTimeout(this.transientTimer);
      this.transientTimer = undefined;
    }
  }

  /** 回到空闲并隐藏浮层。所有"结束"路径都汇到这里，避免遗漏某条路上的清理。 */
  private toIdle(): void {
    this.clearConfirmTimer();
    this.current = 'idle';
    this.pendingText = '';
    this.deps.overlay(null);
  }
}
