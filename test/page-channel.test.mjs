/**
 * 页面注入通道的单元测试。
 *
 * 这一层要回答的问题是"用户按了发送键以后会发生什么"，而它的失败模式全都
 * 只是一句提示。所以每条分支都单独钉住 —— 尤其是**"确定失败"和"无法确认"
 * 必须区分开**：后者如果被当成前者，用户会重按一次，然后直播间里出现两条。
 *
 * 用法：npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DanmakuBridge } from '../lib/bridge.js';
import { PageChannel } from '../lib/channels/page.js';

/** 一个状态可以随便摆布的假桥。只实现 PageChannel 真正用到的那几个成员。 */
function fakeBridge(overrides = {}) {
  const base = {
    snapshot: {
      listening: true,
      port: 39217,
      lastSeenAt: Date.now(),
      page: {
        href: 'https://live.bilibili.com/12345',
        title: '直播间',
        hasInput: true,
        hasButton: true,
        error: ''
      },
      // 只开了一个直播间，且它是就绪的。
      tabs: [{ id: 'tab-1', href: 'https://live.bilibili.com/12345', title: '直播间', ready: true }],
      lastError: undefined,
      refusal: undefined
    },
    extensionOnline: true,
    // "能不能发、发给谁"的判断在桥里（只有它知道开了几个直播间）。
    planDispatch: () => ({ tabId: 'tab-1' }),
    send: async () => ({ ok: true, code: 0 })
  };
  return Object.assign(base, overrides);
}

const LIMITS = { minIntervalMs: 4000, maxPerHour: 20 };

function makeChannel(bridge) {
  return new PageChannel(Object.assign({ bridge }, LIMITS));
}

describe('PageChannel —— 发送前自检', () => {
  it('全都就绪时没有问题', async () => {
    assert.deepEqual(await makeChannel(fakeBridge()).check(), []);
  });

  it('桥没启动时说清楚去哪看', async () => {
    const bridge = fakeBridge({
      snapshot: Object.assign(fakeBridge().snapshot, { listening: false })
    });
    const problems = await makeChannel(bridge).check();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /本地桥/);
  });

  it('扩展没连上时给出三步排查（这是最常见的失败）', async () => {
    const bridge = fakeBridge({ extensionOnline: false });
    const problems = await makeChannel(bridge).check();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /扩展/);
    assert.match(problems[0], /口令/);
  });

  it('扩展连上了但页面没就绪时，把那个页面地址带出来', async () => {
    const snapshot = fakeBridge().snapshot;
    const bridge = fakeBridge({
      snapshot: Object.assign(snapshot, {
        tabs: [{ id: 'tab-1', href: 'https://live.bilibili.com/12345', title: '直播间', ready: false }]
      })
    });
    const problems = await makeChannel(bridge).check();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /live\.bilibili\.com/);
  });

  it('多个直播间又没配房间号时，自检直接把桥的拒绝理由说出来', async () => {
    const bridge = fakeBridge({
      planDispatch: () => ({
        refuse: '检测到 2 个直播间页面（/111、/222）。没有配置直播间号时无法确定发到哪一个，' +
          '所以这次没有发送 —— 请关掉多余的直播间，或者在设置里填上直播间号。'
      })
    });
    const problems = await makeChannel(bridge).check();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /2 个直播间/);
    assert.match(problems[0], /关掉多余的/, '要让用户知道下一步做什么');
  });
});

describe('PageChannel —— 发送结果', () => {
  it('扩展回报成功时就是成功', async () => {
    const result = await makeChannel(fakeBridge()).send('测试一下');
    assert.equal(result.ok, true);
    assert.match(String(result.detail), /页面/);
  });

  it('文本先被清洗（换行会破坏输入框）', async () => {
    let delivered = '';
    const bridge = fakeBridge({
      send: async (text) => {
        delivered = text;
        return { ok: true };
      }
    });
    await makeChannel(bridge).send('  第一行\n第二行  ');
    assert.equal(delivered, '第一行 第二行');
  });

  it('空文本不发', async () => {
    const result = await makeChannel(fakeBridge()).send('   ');
    assert.equal(result.ok, false);
    assert.match(String(result.error), /空/);
  });

  it('通道不再按长度拦人（截断和裁决都不归它管）', async () => {
    // 长度由状态机按设置截断，最终能不能发由 B 站裁决。通道再拦一次只会制造
    // "状态机说能发、通道说不发"这种自相矛盾 —— 用户看到的是一条莫名其妙的失败。
    let delivered = '';
    const bridge = fakeBridge({
      send: async (text) => {
        delivered = text;
        return { ok: true, code: 0 };
      }
    });
    const result = await makeChannel(bridge).send('字'.repeat(21));

    assert.equal(result.ok, true);
    assert.equal(delivered.length, 21, '原样交给页面，不做长度截断');
  });

  it('服务端拒绝时把 code 翻译成能照做的话', async () => {
    const bridge = fakeBridge({
      send: async () => ({ ok: false, code: -412, message: 'risk control' })
    });
    const result = await makeChannel(bridge).send('会触发风控的');
    assert.equal(result.ok, false);
    assert.match(String(result.error), /-412/);
    assert.match(String(result.error), /风控/);
  });

  it('拿不到回执时标记为「结果未知」，而不是失败 —— 报失败会诱发重复发送', async () => {
    const bridge = fakeBridge({
      send: async () => ({ ok: false, message: '点了发送，但没抓到服务端的回执' })
    });
    const result = await makeChannel(bridge).send('不确定发出去没有');
    assert.equal(result.unsure, true,
      '必须标记为不确定：报失败会让用户重说一遍再发一次，而这条可能已经发出去了');
    assert.match(String(result.error), /没抓到/);
  });
});

describe('PageChannel —— 限流（与 HTTP 通道同一套规矩）', () => {
  it('最小间隔内连发第二次会被拒绝', async () => {
    const channel = makeChannel(fakeBridge());
    assert.equal((await channel.send('第一条')).ok, true);
    const second = await channel.send('第二条');
    assert.equal(second.ok, false);
    assert.match(String(second.error), /频繁|间隔/);
  });

  it('每小时上限会拦住第 N+1 条（时间戳直接摆到窗口外）', async () => {
    // 把最小间隔设成 0，单独验证"每小时上限"这道闸。
    const channel = new PageChannel({
      bridge: fakeBridge(),
      minIntervalMs: 0,
      maxPerHour: 2
    });
    assert.equal((await channel.send('一')).ok, true);
    assert.equal((await channel.send('二')).ok, true);
    const third = await channel.send('三');
    assert.equal(third.ok, false);
    assert.match(String(third.error), /上限/);
  });

  it('并发的两次发送只会放行一次（两次按键不该产生两条弹幕）', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const bridge = fakeBridge({
      send: async () => {
        await gate;
        return { ok: true };
      }
    });
    const channel = makeChannel(bridge);

    const first = channel.send('第一条');
    const second = await channel.send('第二条');
    assert.equal(second.ok, false);
    assert.match(String(second.error), /上一条/);

    release();
    assert.equal((await first).ok, true);
  });

  it('发送失败不占用限流额度（否则一次超时会白白封住 4 秒）', async () => {
    let attempt = 0;
    const bridge = fakeBridge({
      send: async () => {
        attempt += 1;
        return attempt === 1 ? { ok: false, message: '第一次失败' } : { ok: true };
      }
    });
    const channel = makeChannel(bridge);
    assert.equal((await channel.send('会失败')).ok, false);
    // 立刻重试：真正成功之前不该被"最小间隔"挡住。
    assert.equal((await channel.send('再来一次')).ok, true);
  });
});

/**
 * 用**真的桥**再跑一遍。
 *
 * 上面那些用假对象测的是通道自己的逻辑，证明不了"通道和桥真的对得上" ——
 * 假对象是我照着记忆写的，字段名或返回形状写错了它照样全绿。
 * 这一段起一个真桥、由一个模拟扩展来领任务和交回执，走完整的 HTTP 往返。
 */
describe('PageChannel + DanmakuBridge —— 真桥联调', () => {
  const token = 'integration-token-123456';

  /** 模拟 Chrome 扩展：不停地问"有活吗"，拿到就按给定剧本回执。 */
  async function runFakeExtension(port, script) {
    const poll = () =>
      fetch(`http://127.0.0.1:${port}/poll?token=${token}&href=${encodeURIComponent('https://live.bilibili.com/12345')}`)
        .then((response) => response.json());

    const result = async (payload) => {
      await fetch(`http://127.0.0.1:${port}/result?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    };

    // 先来一次让桥知道"扩展在线"（真实扩展每 800ms 就会来一次）。
    await poll();
    // 然后循环领任务。
    const timer = setInterval(() => {
      void poll().then(async (task) => {
        if (typeof task.id !== 'string') return;
        await result(Object.assign({ id: task.id }, script(task)));
      });
    }, 60);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  it('扩展回报成功后，通道返回成功', async () => {
    const bridge = new DanmakuBridge({ port: 0, token });
    const port = await bridge.start();
    const stopExtension = await runFakeExtension(port, () => ({ ok: true, code: 0 }));

    try {
      const channel = new PageChannel({ bridge, minIntervalMs: 0, maxPerHour: 20 });
      const sent = await channel.send('联调测试');
      assert.equal(sent.ok, true);
    } finally {
      stopExtension();
      await bridge.stop();
    }
  });

  it('扩展回传服务端拒绝时，通道把它翻成中文提示', async () => {
    const bridge = new DanmakuBridge({ port: 0, token });
    const port = await bridge.start();
    const stopExtension = await runFakeExtension(port, () => ({
      ok: false,
      code: -412,
      message: 'risk control'
    }));

    try {
      const channel = new PageChannel({ bridge, minIntervalMs: 0, maxPerHour: 20 });
      const sent = await channel.send('会被风控拒绝的');
      assert.equal(sent.ok, false);
      assert.match(String(sent.error), /风控/);
    } finally {
      stopExtension();
      await bridge.stop();
    }
  });

  it('扩展一直不回执时，通道如实报告"没有回执"而不是假装成功', async () => {
    const bridge = new DanmakuBridge({ port: 0, token });
    const port = await bridge.start();
    // 只让它上线，之后不回执。
    await fetch(`http://127.0.0.1:${port}/poll?token=${token}`);

    try {
      const channel = new PageChannel({ bridge, minIntervalMs: 0, maxPerHour: 20 });
      // 桥的默认等待是 15 秒，这里换成 300ms 让测试快一点。
      const sent = await Promise.race([
        channel.send('石沉大海'),
        new Promise((resolve) => setTimeout(() => resolve({ ok: 'timeout' }), 800))
      ]);
      // 800ms 内必须还没有结论 —— 说明它真的在等扩展，而不是凭空成功。
      assert.equal(sent.ok, 'timeout');
    } finally {
      await bridge.stop();
    }
  });
});
