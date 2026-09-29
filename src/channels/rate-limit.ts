/**
 * 发送闸门：限流 + 并发保护。
 *
 * ## 为什么它必须被两个通道共用
 *
 * 这条规矩是这个项目的底线：**限流是防止账号被风控的唯一保险丝**，而不是
 * "可选的健壮性"。它原本长在 `bilibili.ts` 里，但页面注入通道必须执行
 * **完全一样**的规矩 —— 如果每个通道各写一份，"换个发送方式就顺手放宽了限制"
 * 这种事迟早会发生，而且不会有任何测试报错。
 *
 * 何况两条通道的上限本来就该一致：风控看的是账号的行为节奏，不是你用哪条路
 * 把这条弹幕送出去的。
 */

/** 限流参数。与设置里的字段一一对应。 */
export interface RateLimitOptions {
  /** 两条弹幕之间的最小间隔（毫秒）。 */
  minIntervalMs: number;
  /** 每小时发送上限。 */
  maxPerHour: number;
}

/** 一小时窗口。 */
const WINDOW_MS = 60 * 60 * 1000;

export class SendGuard {
  /** 已成功发送的时间戳。只保留一小时窗口内的记录。 */
  private readonly sentAt: number[] = [];
  /** 同一时刻只允许一次发送：并发的两次按键不该产生两条弹幕。 */
  private inFlight = false;

  constructor(private readonly options: RateLimitOptions) {}

  /**
   * 尝试占用发送权。
   *
   * **必须**与 `release()` 配对（放在 `finally` 里）：占用了不释放会让通道
   * 永久卡在"上一条还在发送中"。
   *
   * @param now - 当前时间，便于单测注入。
   * @returns 被拒绝时的原因（可直接展示给用户）；返回 `undefined` 表示已占用，
   *   调用方可以发送，但必须 `release()`。
   */
  acquire(now: number = Date.now()): string | undefined {
    if (this.inFlight) return '上一条还在发送中';

    const throttle = this.checkThrottle(now);
    if (throttle !== undefined) return throttle;

    this.inFlight = true;
    return undefined;
  }

  /** 发送成功后记账。只有**真的发出去了**才调它。 */
  recordSuccess(now: number = Date.now()): void {
    this.sentAt.push(now);
  }

  /** 释放发送权。无论成败都要调。 */
  release(): void {
    this.inFlight = false;
  }

  /** 当前窗口内已成功发送的条数。用于诊断显示。 */
  get sentInWindow(): number {
    this.prune(Date.now());
    return this.sentAt.length;
  }

  /** 距离下一次可以发送还有多少毫秒；随时可发时为 0。 */
  get waitMs(): number {
    const now = Date.now();
    this.prune(now);
    const last = this.sentAt[this.sentAt.length - 1];
    if (last === undefined) return 0;
    return Math.max(0, this.options.minIntervalMs - (now - last));
  }

  /**
   * 检查是否允许发送。
   * @returns 不允许时的原因；允许时返回 undefined。
   */
  private checkThrottle(now: number): string | undefined {
    this.prune(now);

    const last = this.sentAt[this.sentAt.length - 1];
    if (last !== undefined) {
      const elapsed = now - last;
      if (elapsed < this.options.minIntervalMs) {
        const waitSeconds = Math.ceil((this.options.minIntervalMs - elapsed) / 1000);
        return `发送过于频繁，请等 ${waitSeconds} 秒（最小间隔 ${this.options.minIntervalMs} ms）`;
      }
    }

    if (this.sentAt.length >= this.options.maxPerHour) {
      return `已达每小时 ${this.options.maxPerHour} 条的上限。这是防止意外连发的保险丝。`;
    }
    return undefined;
  }

  /** 丢掉窗口外的记录，避免数组无限增长。 */
  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.sentAt.length > 0 && (this.sentAt[0] as number) < cutoff) this.sentAt.shift();
  }
}
