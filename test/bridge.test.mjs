/**
 * 本地桥的单元测试。
 *
 * 桥是"插件 ↔ Chrome 扩展"唯一的连接面，而它失败的方式全都很难查：
 * 端口没监听、口令不匹配、任务派发给了错误的标签页、超时后回执才回来……
 * 这些在真实使用中都只是"按了没反应"。所以这里把每条路径单独钉住。
 *
 * 房间号一律用假号（111、222、12345、99999）：真实的直播间号会把一个公开仓库
 * 和你的账号绑定在一起，`npm run test:secrets` 会拦住它。
 *
 * 用法：npm test
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { DanmakuBridge, generateBridgeToken, roomIdOf } from '../lib/bridge.js';

/** 起一个用随机端口的桥（port 0 = 让系统分配，测试之间不会抢端口）。 */
async function startBridge(options = {}) {
  const token = options.token ?? 'test-token-0123456789';
  const bridge = new DanmakuBridge({ port: 0, token });
  const port = await bridge.start();
  return { bridge, port, token };
}

describe('DanmakuBridge —— 启动与鉴权', () => {
  let bridge;
  let port;

  before(async () => {
    ({ bridge, port } = await startBridge());
  });

  after(async () => {
    await bridge.stop();
  });

  it('启动后监听在一个真实端口上', () => {
    assert.ok(port > 0);
    assert.equal(bridge.snapshot.listening, true);
    assert.equal(bridge.snapshot.port, port);
  });

  it('端口随时可查（设置页要显示它）', () => {
    assert.equal(typeof bridge.snapshot.port, 'number');
  });

  it('没有口令时拒绝启动', async () => {
    const bare = new DanmakuBridge({ port: 0, token: '   ' });
    await assert.rejects(() => bare.start(), /口令/);
  });

  it('口令不对一律 403', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/poll?token=wrong`);
    assert.equal(response.status, 403);
  });

  it('没有口令参数的请求也是 403（不能因为"没带"就放行）', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/poll`);
    assert.equal(response.status, 403);
  });

  it('口令正确时放行', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/poll?token=test-token-0123456789`);
    assert.equal(response.status, 200);
  });

  it('不发 CORS 头：网页里的脚本即使猜到口令也读不到响应', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/poll?token=test-token-0123456789`);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('未知端点返回 404 而不是静默成功', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/nope?token=test-token-0123456789`);
    assert.equal(response.status, 404);
  });
});

describe('DanmakuBridge —— 任务派发与回执', () => {
  let bridge;
  let port;
  const token = 'test-token-0123456789';
  const poll = (href = '') =>
    fetch(`http://127.0.0.1:${port}/poll?token=${token}&href=${encodeURIComponent(href)}`)
      .then((response) => response.json());

  /**
   * 模拟"扩展来问过一次"。
   *
   * 真实场景里扩展每 800ms 就会来一次，所以按下发送键时桥**总是**见过它。
   * 测试必须先把这一步补上，否则测的是"扩展一次都没来过"那条路径。
   */
  const wake = () => poll();

  before(async () => {
    ({ bridge, port } = await startBridge({ token }));
  });

  after(async () => {
    await bridge.stop();
  });

  it('没有任务时返回空对象（扩展据此判断"这次没事干"）', async () => {
    assert.deepEqual(await poll(), {});
  });

  it('一次都没连过时立刻失败，并说清楚要检查什么', async () => {
    const fresh = new DanmakuBridge({ port: 0, token });
    await fresh.start();
    const result = await fresh.send('没人接');
    assert.equal(result.ok, false);
    assert.match(String(result.message), /从来没有连接过/);
    await fresh.stop();
  });

  it('send() 的任务会在下一次轮询里被取走', async () => {
    await wake();
    const pending = bridge.send('测试弹幕');
    const task = await poll('https://live.bilibili.com/12345');
    assert.equal(task.text, '测试弹幕');
    assert.equal(typeof task.id, 'string');

    await fetch(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, ok: true, code: 0, message: '' })
    });
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.code, 0);
  });

  it('任务只会被取走一次（两个标签页不会各发一条）', async () => {
    await wake();
    const pending = bridge.send('只发一次');
    const first = await poll();
    const second = await poll();
    assert.equal(first.text, '只发一次');
    assert.deepEqual(second, {});

    await fetch(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: first.id, ok: true })
    });
    await pending;
  });

  it('服务端拒绝会原样带回 code，供上层翻译成人话', async () => {
    await wake();
    const pending = bridge.send('会被拒的');
    const task = await poll();
    await fetch(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, ok: false, code: -412, message: '被风控拦截' })
    });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, -412);
  });

  it('超时后回执才回来时不会串台（丢弃并告警）', async () => {
    await wake();
    const pending = bridge.send('会超时的', 120);
    const task = await poll();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(String(result.message), /超时|回执|掉线/);

    // 迟到很久的回执：桥记录过这个 id 已经没了，不能崩、也不能影响别的任务。
    const late = await fetch(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, ok: true })
    });
    assert.equal(late.status, 200);
  });
});

/**
 * 多个直播间时怎么派发 —— 这一组钉住用户定的三条规则：
 *
 * | 打开的直播间 | 配了房间号 | 行为 |
 * |---|---|---|
 * | 只有一个 | 无所谓 | **直接发**（填没填都不该拦） |
 * | 多个 | 配了 | 发给匹配的那个 |
 * | 多个 | 没配 | **不发**，让用户去关掉多余的 |
 *
 * 第一版只有"谁先轮询谁拿走"，于是多个直播间时弹幕会随机落到其中一个 ——
 * 那是会把弹幕发进别人房间的 bug。
 */
describe('DanmakuBridge —— 多个直播间怎么派发', () => {
  let bridge;
  let port;
  const token = 'multi-tab-token-000';

  /** 让某个标签页来轮询。`tab` 就是内容脚本自己生成的那个 id。 */
  const poll = (tab, href) =>
    fetch(`http://127.0.0.1:${port}/poll?token=${token}` +
      `&tab=${encodeURIComponent(tab)}&href=${encodeURIComponent(href)}`)
      .then((response) => response.json());

  const report = async (tab, href, ready) => {
    await fetch(`http://127.0.0.1:${port}/page?token=${token}&tab=${encodeURIComponent(tab)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ href, title: 't', hasInput: ready, hasButton: ready, error: '' })
    });
  };

  const reply = (id) =>
    fetch(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok: true })
    });

  before(async () => {
    ({ bridge, port } = await startBridge({ token }));
  });

  after(async () => {
    await bridge.stop();
  });

  it('只开一个直播间：即使配了房间号且对不上，也照发（没有歧义）', async () => {
    bridge.setTargetRoomId('12345');
    await poll('solo', 'https://live.bilibili.com/99999');

    const pending = bridge.send('单页面直接发', 2000);
    const task = await poll('solo', 'https://live.bilibili.com/99999');
    assert.equal(task.text, '单页面直接发',
      '只开一个直播间时不该因为房间号对不上就拒绝 —— 那会让人莫名其妙发不出去');

    await reply(task.id);
    assert.equal((await pending).ok, true);
  });

  it('多个直播间 + 没配房间号：**立即拒绝**，不用等超时', async () => {
    const fresh = new DanmakuBridge({ port: 0, token });
    const freshPort = await fresh.start();
    const talk = (tab, href) => fetch(
      `http://127.0.0.1:${freshPort}/poll?token=${token}&tab=${tab}&href=${encodeURIComponent(href)}`
    ).then((r) => r.json());

    await talk('a', 'https://live.bilibili.com/111');
    await talk('b', 'https://live.bilibili.com/222');

    const started = Date.now();
    const result = await fresh.send('不知道发给谁', 30000);
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.match(String(result.message), /多个直播间|2 个/);
    assert.match(String(result.message), /关掉|直播间号/, '要告诉用户下一步做什么');
    assert.ok(elapsed < 1000,
      `必须立即拒绝（实际等了 ${elapsed}ms）—— 注定发不出去的事不该让用户干等 15 秒`);

    await fresh.stop();
  });

  it('多个直播间 + 配了房间号：发给匹配的那个，别的标签页拿不到', async () => {
    const fresh = new DanmakuBridge({ port: 0, token });
    const freshPort = await fresh.start();
    const talk = (tab, href) => fetch(
      `http://127.0.0.1:${freshPort}/poll?token=${token}&tab=${tab}&href=${encodeURIComponent(href)}`
    ).then((r) => r.json());
    const replyTo = (id) => fetch(`http://127.0.0.1:${freshPort}/result?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok: true })
    });

    fresh.setTargetRoomId('12345');
    await talk('mine', 'https://live.bilibili.com/12345');
    await talk('other', 'https://live.bilibili.com/99999');

    const pending = fresh.send('发给我的房间', 2000);

    // 别人的标签页先来问，也必须拿不到。
    assert.deepEqual(await talk('other', 'https://live.bilibili.com/99999'), {},
      '不匹配的标签页绝不能抢走任务');

    const task = await talk('mine', 'https://live.bilibili.com/12345');
    assert.equal(task.text, '发给我的房间');

    await replyTo(task.id);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.target, 'https://live.bilibili.com/12345',
      '回执要带上是哪个直播间收的 —— 用户要知道发到哪了');

    await fresh.stop();
  });

  it('多个直播间 + 配了房间号但一个都不匹配：拒绝并说清两边分别是什么', async () => {
    const fresh = new DanmakuBridge({ port: 0, token });
    const freshPort = await fresh.start();
    const talk = (tab, href) => fetch(
      `http://127.0.0.1:${freshPort}/poll?token=${token}&tab=${tab}&href=${encodeURIComponent(href)}`
    ).then((r) => r.json());

    fresh.setTargetRoomId('12345');
    await talk('a', 'https://live.bilibili.com/111');
    await talk('b', 'https://live.bilibili.com/222');

    const result = await fresh.send('发不出去', 30000);
    assert.equal(result.ok, false);
    assert.match(String(result.message), /12345/, '要说清设置里配的是什么');
    assert.match(String(result.message), /111|222/, '也要说清现在打开的是什么');

    await fresh.stop();
  });

  it('关掉多余的标签页之后就能正常发（标签页会自然过期）', async () => {
    const fresh = new DanmakuBridge({ port: 0, token });
    const freshPort = await fresh.start();
    const talk = (tab, href) => fetch(
      `http://127.0.0.1:${freshPort}/poll?token=${token}&tab=${tab}&href=${encodeURIComponent(href)}`
    ).then((r) => r.json());
    const replyTo = (id) => fetch(`http://127.0.0.1:${freshPort}/result?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok: true })
    });

    await talk('a', 'https://live.bilibili.com/111');
    await talk('b', 'https://live.bilibili.com/222');
    assert.equal((await fresh.send('两个页面时发不出去', 30000)).ok, false);

    // 模拟"关掉一个"：超过 3 秒不再来轮询，它就自动过期了。
    await new Promise((r) => setTimeout(r, 3200));
    await talk('a', 'https://live.bilibili.com/111');

    const pending = fresh.send('关掉一个之后就能发了', 2000);
    const task = await talk('a', 'https://live.bilibili.com/111');
    assert.equal(task.text, '关掉一个之后就能发了',
      '用户按提示关掉多余的标签页之后，必须马上就能用');

    await replyTo(task.id);
    assert.equal((await pending).ok, true);

    await fresh.stop();
  });

  it('目标标签页中途被关掉：立即报错，不让用户干等超时', async () => {
    const fresh = new DanmakuBridge({ port: 0, token });
    const freshPort = await fresh.start();
    const talk = (tab, href) => fetch(
      `http://127.0.0.1:${freshPort}/poll?token=${token}&tab=${tab}&href=${encodeURIComponent(href)}`
    ).then((r) => r.json());

    fresh.setTargetRoomId('111');
    await talk('mine', 'https://live.bilibili.com/111');
    await talk('other', 'https://live.bilibili.com/222');

    // 30 秒超时 —— 但我们要求它在几秒内就报错。
    const pending = fresh.send('发给一个马上会被关掉的页面', 30000);
    const started = Date.now();

    // 模拟用户关掉了目标标签页：超过 3 秒的活跃窗口，它就算没了。
    await new Promise((r) => setTimeout(r, 3300));

    const result = await pending;
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.match(String(result.message), /不在了|关掉/, '要说清是目标页面没了，而不是含糊的"没有回执"');
    assert.ok(elapsed < 10000,
      `必须尽快报错（实际 ${elapsed}ms）—— 目标页面都没了，等到 30 秒超时毫无意义`);

    await fresh.stop();
  });

  it('房间号按路径段精确比较，不会被前缀骗到', () => {
    // 字符串包含会把 "123" 匹配到 "/12345" 上 —— 那意味着弹幕被发进别人的房间。
    assert.equal(roomIdOf('https://live.bilibili.com/12345'), '12345');
    assert.notEqual(roomIdOf('https://live.bilibili.com/12345'), '123');
    assert.equal(roomIdOf('https://live.bilibili.com/12345?x=1'), '12345');
    assert.equal(roomIdOf('https://live.bilibili.com/'), '');
    assert.equal(roomIdOf('不是地址'), '');
  });
});

describe('DanmakuBridge —— 生命周期', () => {
  it('停止时让所有在等的发送立刻失败，而不是等到超时', async () => {
    const { bridge, port, token } = await startBridge({ token: 'stop-test-token-000' });
    // 先让桥知道"扩展来过"，否则 send 会走"从来没连过"那条快速失败路径。
    await fetch(`http://127.0.0.1:${port}/poll?token=${token}`);
    const pending = bridge.send('会被中断', 30000);

    await bridge.stop();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(String(result.message), /停止/);
    assert.equal(bridge.snapshot.listening, false);
  });

  it('可以重复停止而不出错', async () => {
    const { bridge } = await startBridge({ token: 'idempotent-token-000' });
    await bridge.stop();
    await bridge.stop();
    assert.equal(bridge.snapshot.listening, false);
  });

  it('端口被占用时抛错，而不是静默换一个端口', async () => {
    // 静默换端口是最糟的处理：扩展还指着老端口，而界面上一切正常。
    const first = new DanmakuBridge({ port: 0, token: 'port-clash-token-000' });
    const port = await first.start();

    const second = new DanmakuBridge({ port, token: 'port-clash-token-000' });
    await assert.rejects(() => second.start(), /端口/);
    await first.stop();
  });
});

describe('generateBridgeToken', () => {
  it('生成 32 位十六进制串，且每次都不同', () => {
    const first = generateBridgeToken();
    const second = generateBridgeToken();
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.notEqual(first, second);
  });
});
