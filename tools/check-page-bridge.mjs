#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 本地桥的装配校验
 * ============================================================================
 * 用**真实的插件 `apply` + 真实的设置服务**，验证桥跟着配置走的那套逻辑：
 *
 *   1. 用 HTTP 通道时桥不监听（不占端口、少一个入口）；
 *   2. 切到页面通道时桥起来，并在口令为空时**自动生成一个写回设置**；
 *   3. 口令写回后桥用的是新口令（两步之间不能死锁）；
 *   4. 模拟扩展轮询之后，状态一路从 waiting → not-ready → ready 走对；
 *   5. 切回 HTTP 通道时桥停掉。
 *
 * ## 为什么这一层必须单独测
 *
 * 上面的每一条错了，表现都是**用户在设置页上看到"已启用"而实际上什么都没发生**。
 * 桥自己的单元测试（test/bridge.test.mjs）测不到这些 —— 它们测的是桥的内部行为，
 * 而这里错的是"插件什么时候把它拉起来、拿什么口令拉起来"。
 *
 * 刻意把 `behavior.autoStart` 设为 false：这样插件不会去拉 sidecar，
 * 本检查也就不依赖 spawn 权限（受限环境里那个会被拦）。
 *
 * 用法：node tools/check-page-bridge.mjs
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const profileModules = join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  '.dsh',
  'profiles',
  'node_modules'
);

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[page] 本地桥装配校验（真插件 + 真设置服务）\n');

// --- 加载 DSH 真实实现 -------------------------------------------------------
let SettingsProvider;
let Service;
let Context;
try {
  const settingsModule = await import(
    pathToFileURL(join(profileModules, '@deepseek-ai', 'dsh-settings', 'lib', 'index.js')).href
  );
  SettingsProvider = settingsModule.SettingsProvider;
  const cordisModule = await import(
    pathToFileURL(join(profileModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
  );
  Service = cordisModule.Service;
  Context = cordisModule.Context;
} catch (cause) {
  console.error(`[page] 无法加载 DSH 的设置服务实现：${cause.message}`);
  console.error('[page] 这个检查需要有 DSH 安装（和 tools/check-settings.mjs 同一前提）。');
  process.exit(1);
}

class MemorySettings extends SettingsProvider {
  writable = true;

  constructor(document_) {
    super(new Context());
    this.stored = { ...document_ };
  }

  async load() {
    return { ...this.stored };
  }

  async persist(ns, section) {
    this.stored[ns] = section;
  }

  async initialize() {
    const generator = this[Service.init]();
    let step = await generator.next();
    while (step.done !== true) step = await generator.next();
  }
}

/**
 * 轮询等待一个条件成立。
 *
 * `predicate` 可以是异步的 —— 这一点必须显式 await，否则拿到的是一个 Promise，
 * 而 Promise 恒为真值，等待会**立刻假通过**（我第一版就是这么写的，
 * 于是"桥开始监听"那条断言在桥其实没起来时也是绿的）。
 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined && value !== false && value !== null) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）`);
}

const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);

/**
 * 用一个随机的高位端口，而不是默认的 39217。
 *
 * 因为**真实插件可能正占着那个端口**（用户切到页面通道之后就会）：那样这个检查
 * 会在"桥起不来"上失败，而失败原因跟它要验证的东西毫无关系。
 * 测试不该依赖"跑测试时别的实例恰好不在"。
 */
const testPort = 40000 + Math.floor(Math.random() * 20000);

// --- 装起来 ------------------------------------------------------------------
const provider = new MemorySettings({
  'voice-danmaku': {
    // 关键：不拉 sidecar，这样本检查不需要 spawn 权限。
    behavior: { autoStart: false },
    // 不写 provider：页面通道是默认值，这里顺带验证"默认值就是它"。
    channel: { page: { port: testPort } }
  }
});
await provider.initialize();

let scope;
let disposer;
const fakeCtx = {
  inject: (_services, callback) => {
    callback({ settings: { register: (ns, schema, options) => {
      scope = provider.register(ns, schema, options);
      return scope;
    } } });
  },
  effect: (body) => {
    disposer = body();
  }
};

plugin.apply(fakeCtx);
await new Promise((r) => setTimeout(r, 500));

if (scope === undefined) {
  console.error('[page] 插件没有注册设置命名空间，后面的检查没有意义。');
  process.exit(1);
}

const configValue = () => scope.get();
const token = () => String(configValue().channel.page.token ?? '');
const port = () => Number(configValue().channel.page.port);
const status = () => String(configValue().channel.page.status ?? '');

/** 探测桥在不在：直接按配置的端口发一个带口令的 /status。 */
async function bridgeAlive() {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port()}/status?token=${encodeURIComponent(token())}`,
      { signal: AbortSignal.timeout(1000) }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// --- 1. 页面通道是默认也是唯一的通道，桥应当自己起来 -------------------------
//
// 这里曾经验证"用 HTTP 通道时桥不占端口、切过去才起来"。那条通道已经删掉了
// （它需要用户存 Cookie，而且缺 wbi 签名），所以现在只剩一件事要验证：
// **插件一启动桥就该在**（扩展随时可能来连）。
check(configValue().channel.provider === 'page', '默认（也是唯一）的通道是 page',
  configValue().channel.provider);

// --- 2. 口令自动生成并回写 ---------------------------------------------------
const generated = await waitFor(
  () => (token().length > 0 ? token() : undefined),
  8000,
  '宿主自动生成口令并回写'
);
check(/^[0-9a-f]{32}$/.test(generated), '口令自动生成且形如 32 位十六进制', generated);
check(provider.stored['voice-danmaku']?.channel?.page?.token === generated,
  '口令被持久化（下次启动不用再生成）');

await waitFor(async () => (await bridgeAlive()) || undefined, 5000, '桥开始监听');
check(true, '桥起来了，并在配置的端口上应答');

// --- 3. 状态机：waiting → not-ready → ready ----------------------------------
const settled = await waitFor(
  () => (status() === 'waiting' ? 'waiting' : undefined),
  8000,
  '状态变为 waiting'
);
check(settled === 'waiting', '扩展没来时状态是 waiting（而不是含糊的"没反应"）',
  `status=${status()}`);

// 模拟扩展：**持续**轮询（真实扩展是每 800ms 一次）。
//
// 这一步不能只做一次：桥判断"扩展在不在线"的依据是"最近 3 秒内有没有来过"，
// 所以只 poll 一次的话，3 秒后桥就认为扩展掉线了 —— 而宿主的巡检正好是每 5 秒
// 一次，于是永远看到"不在线"。第一版测试就是这么写的，白等了两轮。
let pageReport = {
  href: 'https://live.bilibili.com/12345',
  title: '测试直播间',
  hasInput: false,
  hasButton: false,
  error: ''
};

const extensionTimer = setInterval(() => {
  const url = `http://127.0.0.1:${port()}/poll?token=${encodeURIComponent(token())}` +
    `&href=${encodeURIComponent('https://live.bilibili.com/12345')}`;
  void fetch(url).catch(() => {});
}, 300);
if (typeof extensionTimer.unref === 'function') extensionTimer.unref();

/** 改一下"扩展看到的页面"，下一轮上报就会带过去。 */
const reportPage = (patch) => {
  pageReport = Object.assign({}, pageReport, patch);
};

const reportTimer = setInterval(() => {
  void fetch(`http://127.0.0.1:${port()}/page?token=${encodeURIComponent(token())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pageReport)
  }).catch(() => {});
}, 300);
if (typeof reportTimer.unref === 'function') reportTimer.unref();

await waitFor(() => (status() === 'not-ready' ? 'not-ready' : undefined), 15000,
  '状态变为 not-ready');
check(true, '扩展连上但页面没就绪时状态是 not-ready（不是含糊的"没反应"）');

// 页面就绪了。
reportPage({ hasInput: true, hasButton: true });
await waitFor(() => (status() === 'ready' ? 'ready' : undefined), 15000, '状态变为 ready');
check(true, '页面就绪后状态是 ready（用户看到"可以发了"）');

clearInterval(extensionTimer);
clearInterval(reportTimer);

// --- 4. 卸载时桥要停掉 -------------------------------------------------------
//
// 这一条替代了原来的"切回 HTTP 通道就停桥" —— 那条通道已经删掉了，但
// **不能留一个开着端口的服务在进程里** 这件事没有变。
if (typeof disposer === 'function') await disposer();
await waitFor(
  async () => ((await bridgeAlive()) === false ? 'stopped' : undefined),
  5000,
  '卸载后桥停止监听'
);
check(true, '插件卸载后桥停止监听（不留开着端口的服务）');

// --- 收尾 --------------------------------------------------------------------
await new Promise((r) => setTimeout(r, 300));

console.log(failures === 0
  ? '\n[page] 本地桥装配校验全部通过。'
  : `\n[page] 有 ${failures} 项失败，见上。`);
process.exit(failures === 0 ? 0 : 1);
