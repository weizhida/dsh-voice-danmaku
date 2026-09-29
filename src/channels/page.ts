/**
 * 页面注入通道：让**你自己的浏览器**去发这条弹幕。
 *
 * ## 它和 HTTP 直发的区别到底是什么
 *
 * 不是"更像真人" —— 服务端看到的都是同一条 `POST /msg/send`，它看不见是谁点的
 * 按钮。真正的区别在这三处：
 *
 * 1. **插件里不存任何凭证。** 没有 cookie 可泄露，也就不存在"登录态被别的程序
 *    读走"这条风险。
 * 2. **请求由页面自己发出**，wbi 签名、csrftoken 全由 B 站前端计算。于是
 *    "签名算法变了导致突然发不出去"这类维护负担不存在了。
 * 3. **出问题看得见。** 弹幕有没有出现，直播间页面上直接显示。
 *
 * 代价也说清楚：它依赖直播间页面**开着**，而且依赖 B 站前端结构（扩展按语义找
 * 输入框和按钮，但改版仍然可能打破它）。所以两条通道并存，不是替换关系。
 *
 * ## 关于回执的可信度
 *
 * 扩展会把页面自己收到的服务端响应 hook 回来，所以正常情况下我们拿到的
 * `code` 和 HTTP 通道拿到的是同一个东西。但 hook 有可能失败（B 站换了请求方式），
 * 那时扩展只能报"没抓到回执" —— 这种**无法确认**必须和"确定失败"区分开：
 * 当成失败处理是对的（宁可让用户自己看一眼），但错误文案必须提醒他
 * "可能已经发出去了，别急着重发"，否则会变成重复弹幕。
 */

import { DanmakuBridge } from '../bridge.js';
import { SendGuard } from './rate-limit.js';
import { describeRejection } from './bilibili-codes.js';
import { sanitizeDanmaku, validateDanmaku } from './text.js';
import type { DanmakuChannel, SendResult } from './types.js';

/** 构造参数。 */
export interface PageChannelOptions {
  /** 本地桥。通道不自己起服务，只负责把文本交给它 —— 桥的生命周期归插件管。 */
  bridge: DanmakuBridge;
  minIntervalMs: number;
  maxPerHour: number;
}

export class PageChannel implements DanmakuChannel {
  readonly id = 'page';

  private readonly guard: SendGuard;

  constructor(private readonly options: PageChannelOptions) {
    this.guard = new SendGuard({
      minIntervalMs: options.minIntervalMs,
      maxPerHour: options.maxPerHour
    });
  }

  async check(): Promise<string[]> {
    const problems: string[] = [];
    const bridge = this.options.bridge;

    if (!bridge.snapshot.listening) {
      problems.push('本地桥没有启动（设置 → 语音弹幕 → 发送通道 里看一眼端口和口令）');
      return problems;
    }
    if (!bridge.extensionOnline) {
      problems.push(
        'Chrome 扩展没有连上来。请确认：① 扩展已启用；② Chrome 里打开着直播间页面；' +
        '③ 扩展选项里填的端口与口令和这里一致。'
      );
      return problems;
    }

    // 能不能发、发给谁 —— 判断逻辑全在桥里（它才知道开了几个直播间）。
    // 这里只负责把那句话转述给用户。
    const plan = bridge.planDispatch();
    if ('refuse' in plan) {
      problems.push(plan.refuse);
      return problems;
    }

    const tabs = bridge.snapshot.tabs;
    const target = tabs.find((tab) => tab.id === plan.tabId);
    if (target !== undefined && !target.ready) {
      problems.push(
        `在 ${target.href} 上没找到弹幕输入框或发送按钮。` +
        '请确认这个标签页确实是 B 站直播间页面（并且已登录）。'
      );
    }
    return problems;
  }

  async send(text: string): Promise<SendResult> {
    const message = sanitizeDanmaku(text);
    const invalid = validateDanmaku(message);
    if (invalid !== undefined) return { ok: false, error: invalid };

    // 限流是硬闸，和 HTTP 通道用同一个实现、同一套参数。
    const blocked = this.guard.acquire();
    if (blocked !== undefined) return { ok: false, error: blocked };

    try {
      const result = await this.options.bridge.send(message);
      if (result.ok) {
        this.guard.recordSuccess();
        // 把扩展的原话透传出去。它可能是空的（服务端确认成功），也可能是
        // "页面已接受，但没抓到服务端回执" —— 两者的可信度不一样，用户有权看到。
        return { ok: true, detail: result.message ?? '已通过页面发送' };
      }

      // 有 code 说明扩展真的抓到了服务端的拒绝，这是**确定失败**。
      if (typeof result.code === 'number') {
        return {
          ok: false,
          error: `服务端拒绝（${result.code}）：${describeRejection(result.code, result.message ?? '')}`
        };
      }

      // 没有 code：桥层的问题（超时、扩展掉线）或者钩子失效。
      //
      // **这不能当成"确定失败"**：任务可能已经被扩展领走、点击也生效了，只是
      // 回执没回来。报失败会让用户重说一遍再发一次 —— 直播间里就会出现两条
      // 一模一样的话，而"同一句话短时间发两遍"恰恰是最像机器人的特征。
      //
      // 所以如实地说"不知道"，把处置权交给状态机：它会锁住输入，直到结果明确。
      return {
        ok: false,
        unsure: true,
        error: result.message ?? '扩展没有说明原因'
      };
    } finally {
      this.guard.release();
    }
  }
}
