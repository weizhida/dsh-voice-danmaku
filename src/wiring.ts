/**
 * 长生命周期对象的装配与缓存。
 *
 * ## 为什么这些事需要单独一个模块
 *
 * 有一类 bug 只存在于"装配层"，单元测试测不到，因为它不在任何单个组件的
 * 内部：组件自己是对的，错的是**创建它的方式**。
 *
 * 本项目真实发生过一次：状态机每次发送都调用 `createChannel()` 新建一个通道
 * 实例，而频率限制的状态（已发送时间戳）存在通道对象上——**每次 new 就等于把
 * 限流清零**，最小间隔和每小时上限全部失效。通道自己的单元测试全绿，
 * 因为那些测试是直接构造一个实例并连发两次的。
 *
 * 所以这些"什么时候该复用、什么时候该重建"的决策被集中到这里，
 * 并配有针对装配层本身的测试（test/wiring.test.mjs）。
 */

import { createChannel, type ChannelDependencies } from './channels/registry.js';
import type { DanmakuChannel } from './channels/types.js';
import type { VoiceDanmakuConfig } from './config.js';

/**
 * 按配置构造并缓存弹幕通道。
 *
 * 复用规则是"配置签名不变就复用"，而不是"配置对象引用不变"——
 * 设置服务每次 `get()` 都可能返回新对象，用引用判断会导致每次都重建，
 * 那正是我们要避免的。
 *
 * 这里**只有通道**。录音器一度也在这里缓存，但它的路径要先经过 ffmpeg 探测
 * （`src/ffmpeg.ts`），那是 index.ts 的职责；塞进来只会让这个模块多背一个
 * 与"复用决策"无关的依赖。
 */
export class ComponentCache {
  private channel: DanmakuChannel | undefined;
  private channelSignature = '';

  /**
   * @param deps - 通道需要、但不在设置里的东西（当前是本地桥）。
   *   由插件持有并注入，通道只借来用。
   */
  constructor(private readonly deps: ChannelDependencies) {}

  /**
   * 取弹幕通道实例。
   *
   * **必须复用**（见类注释）：限流状态、以及"正在发送中"的并发互斥都在实例上。
   * 只有影响实例行为的配置变了（通道类型、房间号、限流参数、桥参数）才重建。
   */
  channelFor(config: VoiceDanmakuConfig): DanmakuChannel {
    const signature = [
      config.channel.provider,
      config.channel.roomId,
      String(config.channel.minIntervalMs),
      String(config.channel.maxPerHour),
      // 端口/口令变了也要重建：桥换了地方，旧实例还指着老端口会一直超时。
      String(config.channel.page.port),
      config.channel.page.token
    ].join('\u0000');

    if (this.channel === undefined || this.channelSignature !== signature) {
      this.channel = createChannel(config, this.deps);
      this.channelSignature = signature;
    }
    return this.channel;
  }

  /** 丢弃所有缓存的实例（插件卸载时调用）。 */
  dispose(): void {
    this.channel = undefined;
    this.channelSignature = '';
  }
}
