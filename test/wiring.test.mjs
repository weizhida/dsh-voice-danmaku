/**
 * 装配层的单元测试：**什么时候该复用通道实例，什么时候该重建**。
 *
 * 这一层要单独测，是因为有一类 bug 只存在于"创建方式"里：组件自己是对的，
 * 错的是它被 new 了几次。本项目真实发生过一次 —— 每次发送都新建通道实例，
 * 而频率限制的状态（已发送时间戳）存在实例上，**每次 new 就等于把限流清零**，
 * 最小间隔和每小时上限全部失效。通道自己的单元测试全绿，因为它们都是直接
 * 构造一个实例再连发两次的。
 *
 * 用法：npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ComponentCache } from '../lib/wiring.js';
import { Config } from '../lib/config.js';
import { PageChannel } from '../lib/channels/page.js';

/**
 * 一份字段齐全的默认设置（schema 会铺开所有默认值）。
 */
function baseConfig(overrides = {}) {
  return new Config(overrides);
}

/**
 * 通道需要的"设置之外的东西"。这里只要一个占位对象 ——
 * 构造通道时它只是被存起来，真正用到是在发送那一刻。
 */
const deps = { bridge: {} };

function newCache() {
  return new ComponentCache(deps);
}

describe('ComponentCache —— 通道复用（限流状态不能丢）', () => {
  it('配置不变时返回同一个通道实例', () => {
    const cache = newCache();
    const config = baseConfig({ channel: { roomId: '12345' } });

    const first = cache.channelFor(config);
    const second = cache.channelFor(config);

    assert.equal(first, second, '必须是同一个实例，否则每次发送都会重置限流计数');
  });

  it('即使传入的是等价的**新对象**也要复用（设置服务每次 get 都可能返回新对象）', () => {
    const cache = newCache();
    const first = cache.channelFor(baseConfig({ channel: { roomId: '12345' } }));
    const second = cache.channelFor(baseConfig({ channel: { roomId: '12345' } }));

    assert.equal(first, second, '不能靠对象引用判断，必须靠配置内容');
  });

  it('换直播间号时重建', () => {
    const cache = newCache();
    const first = cache.channelFor(baseConfig({ channel: { roomId: '111' } }));
    const second = cache.channelFor(baseConfig({ channel: { roomId: '222' } }));

    assert.notEqual(first, second);
  });

  it('改限流参数时重建（否则新参数不生效）', () => {
    const cache = newCache();
    const first = cache.channelFor(baseConfig({ channel: { minIntervalMs: 4000 } }));
    const second = cache.channelFor(baseConfig({ channel: { minIntervalMs: 9000 } }));

    assert.notEqual(first, second, '限流参数变了必须换实例，否则改了设置也不起作用');
  });

  it('改本地桥端口时重建（旧实例还指着老端口，会一直超时）', () => {
    const cache = newCache();
    const first = cache.channelFor(baseConfig({ channel: { page: { port: 39217 } } }));
    const second = cache.channelFor(baseConfig({ channel: { page: { port: 40001 } } }));

    assert.notEqual(first, second);
  });

  it('改本地桥口令时重建（换了口令还拿旧的去连，会被 403）', () => {
    const cache = newCache();
    const first = cache.channelFor(baseConfig({ channel: { page: { token: 'a'.repeat(32) } } }));
    const second = cache.channelFor(baseConfig({ channel: { page: { token: 'b'.repeat(32) } } }));

    assert.notEqual(first, second);
  });

  it('不相关的设置变化不该导致重建（避免无谓地丢限流状态）', () => {
    const cache = newCache();
    const first = cache.channelFor(baseConfig({ channel: { roomId: '12345' } }));
    const second = cache.channelFor(baseConfig({
      channel: { roomId: '12345' },
      overlay: { fontSize: 40 }        // 只改了浮层字号
    }));

    assert.equal(first, second, '改浮层外观不该清掉发送限流状态');
  });

  it('返回的确实是页面通道', () => {
    const cache = newCache();
    assert.ok(cache.channelFor(baseConfig()) instanceof PageChannel);
  });
});

describe('ComponentCache —— 释放', () => {
  it('dispose 之后会重建实例（不会把已释放的对象再交出去）', () => {
    const cache = newCache();
    const config = baseConfig();
    const before = cache.channelFor(config);

    cache.dispose();

    const after = cache.channelFor(config);
    assert.notEqual(before, after, 'dispose 后必须重新构造，不能复用已释放的实例');
  });

  it('dispose 可以重复调用而不出错', () => {
    const cache = newCache();
    cache.channelFor(baseConfig());
    cache.dispose();
    cache.dispose();
  });
});

// 注：录音器曾经也由 ComponentCache 缓存，现在改由 index.ts 直接管理 ——
// 因为它依赖 ffmpeg 的探测结果，那是 index.ts 的职责。
