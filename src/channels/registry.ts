/**
 * 通道注册表。
 *
 * 加一个新平台的完整步骤：
 *   1. 实现 `DanmakuChannel`（放在本目录下）；
 *   2. 在 `config.ts` 的 `channel.provider` 枚举里加上它的 id；
 *   3. 在下面的 `switch` 里加一个分支。
 *
 * 状态机不需要任何改动 —— 它只认 `DanmakuChannel` 接口。
 */

import { PageChannel } from './page.js';
import type { DanmakuBridge } from '../bridge.js';
import type { DanmakuChannel } from './types.js';
import type { VoiceDanmakuConfig } from '../config.js';

/** 已支持的通道 id。与 config.ts 里的枚举保持一致。 */
export type ChannelProviderId = VoiceDanmakuConfig['channel']['provider'];

/**
 * 构造通道需要的、**不在设置里**的东西。
 *
 * 本地桥是长生命周期的（扩展连在它上面），所以它由插件持有并注入进来，
 * 通道只借来用 —— 通道自己起一个桥会导致"每换一次配置就换一个端口"，
 * 扩展立刻掉线。
 */
export interface ChannelDependencies {
  bridge: DanmakuBridge;
}

/**
 * 按配置构造通道实例。
 *
 * 每次发送都新建实例是有意的：限流状态（已发送时间戳）属于"这一次会话的
 * 连续使用"，而配置改动后重建可以让新的限流参数立即生效。
 * 代价是配置改动会重置每小时计数 —— 这是可接受的，因为改配置本身是罕见操作。
 */
export function createChannel(config: VoiceDanmakuConfig, deps: ChannelDependencies): DanmakuChannel {
  switch (config.channel.provider) {
    case 'page':
      return new PageChannel({
        bridge: deps.bridge,
        minIntervalMs: config.channel.minIntervalMs,
        maxPerHour: config.channel.maxPerHour
      });
    default: {
      // 枚举把这里收敛成 never：将来加了新 id 却忘了加分支，编译就会报错。
      const exhaustive: never = config.channel.provider;
      throw new Error(`未实现的弹幕通道：${String(exhaustive)}`);
    }
  }
}
