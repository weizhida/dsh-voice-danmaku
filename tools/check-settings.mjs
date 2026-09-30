#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 设置集成校验
 * ============================================================================
 * 用 **DSH 真实的 `SettingsProvider`** 跑一遍本插件的设置 schema。
 *
 * 为什么这一个测试是必要的：`tools/check-plugin.mjs` 用的是我自己写的假上下文，
 * 假到一定程度就只能证明"我的假设自洽"。这个测试换成真的服务实现，
 * 验证的是插件和 DSH 之间真实的接线：
 *
 *   1. `settings.register()` 真的接受我的命名空间与 schema；
 *   2. 用户文档里的值能正确叠加到默认值之上（这是"改设置生效"的基础）；
 *   3. schema 的默认值真的被铺开（**最常见的装配 bug 是这里缺字段**）；
 *   4. `watch()` 能收到变更通知（这是"改按键不用重启"的基础）；
 *   5. 跨字段校验真的会**拒绝写入**，而不只是打印一句抱怨；
 *   6. secret 字段从序列化视图里被剔除。
 *
 * 存储用内存替身（不碰真实的 settings.yaml），但注册、解析、校验、提交、
 * 变更广播全部走 DSH 的真实代码路径。
 *
 * 用法：node tools/check-settings.mjs
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

console.log('[settings] 用 DSH 真实设置服务校验 schema\n');

// --- 加载真实实现 -----------------------------------------------------------
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
  console.error(`[settings] 无法加载 DSH 的设置服务实现：${cause.message}`);
  console.error(`[settings] 期望位置：${profileModules}`);
  process.exit(1);
}

const { Config, SETTINGS_NAMESPACE } = await import(
  pathToFileURL(join(root, 'lib', 'config.js')).href
);

/**
 * 内存版存储提供者。
 * 只替换 `load`/`persist` 两个与磁盘相关的抽象方法，其余逻辑全部继承真实实现。
 */
class MemorySettings extends SettingsProvider {
  writable = true;

  constructor(document) {
    // Service 基类要求一个**真实的** cordis Context：它在构造里就会
    // `ctx.reflect.provide(...)` 把服务注册进去，用普通对象替身会在构造函数
    // 里就抛异常。所以这里用真的 Context，只是不启动完整容器。
    super(new Context());
    this.stored = { ...document };
  }

  async load() {
    return { ...this.stored };
  }

  async persist(ns, section) {
    this.stored[ns] = section;
  }

  /** 手动驱动 Service.init：真实运行时这由 cordis 生命周期调用。 */
  async initialize() {
    const generator = this[Service.init]();
    let step = await generator.next();
    while (step.done !== true) {
      step = await generator.next();
    }
  }
}

const provider = new MemorySettings({});
await provider.initialize();

// --- 1. 注册 -----------------------------------------------------------------
let scope;
try {
  scope = provider.register(SETTINGS_NAMESPACE, Config, {
    applies: 'live',
    validate: (value) => {
      const seen = new Set();
      for (const [action, raw] of Object.entries(value.keys)) {
        if (seen.has(raw)) throw new Error(`按键 ${raw} 被重复使用（${action}）`);
        seen.add(raw);
      }
    }
  });
  check(true, 'register() 接受了命名空间与 schema', SETTINGS_NAMESPACE);
} catch (cause) {
  check(false, 'register() 接受了命名空间与 schema', cause.message);
  process.exit(1);
}

// --- 2. 默认值铺开 -----------------------------------------------------------
const defaults = scope.get();
const requiredPaths = [
  ['keys', 'record', 'F9'],
  ['keys', 'send', 'F11'],
  ['keys', 'cancel', 'F10'],
  // 媒体键默认关闭：它们是与系统和别的程序共享的键，不主动去抢。
  ['mediaKeys', 'enabled', false],
  ['mediaKeys', 'record', 'AudioVolumeMute'],
  ['overlay', 'enabled', true],
  ['overlay', 'fontSize', 26],
  ['overlay', 'clickThrough', true],
  ['overlay', 'anchorXPercent', 50],
  ['audio', 'backend', 'ffmpeg'],
  // 默认留空 = 自动探测。这是刻意的：要求用户手填 ffmpeg 安装路径是不合理的设计。
  ['audio', 'ffmpegPath', ''],
  ['asr', 'engine', 'openai-compatible'],
  ['asr', 'language', 'zh'],
  ['channel', 'provider', 'page'],
  ['channel', 'page', 'port', 39217],
  ['channel', 'minIntervalMs', 4000],
  ['channel', 'maxPerHour', 20],
  ['behavior', 'consumeKeys', true],
  ['behavior', 'confirmTimeoutSeconds', 8],
  // 提示音默认关闭：游戏声音会把它盖住，浮层已经够用。
  ['behavior', 'soundFeedback', false],
  ['behavior', 'autoSendOnRecognized', false]
];

let missing = 0;
// 路径写成 `[...路径, 期望值]`，最后一项是期望值 —— 于是任意深度都能表达
// （`channel.page.port` 这种嵌套字段也要能查）。
for (const entry of requiredPaths) {
  const expected = entry[entry.length - 1];
  const path = entry.slice(0, -1);
  const actual = path.reduce(
    (node, key) => (node === null || node === undefined ? undefined : node[key]),
    defaults
  );
  if (actual !== expected) {
    missing += 1;
    console.log(`      ✗ ${path.join('.')} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
check(missing === 0, `schema 默认值全部铺开（${requiredPaths.length} 个字段）`,
  missing > 0 ? `${missing} 个不符` : '');

// --- 3. 用户层覆盖 -----------------------------------------------------------
await scope.update({ keys: { record: 'PageUp' }, channel: { roomId: '12345' } });
const overridden = scope.get();
check(overridden.keys.record === 'PageUp', '用户值覆盖默认值', overridden.keys.record);
check(overridden.keys.send === 'F11', '未覆盖的字段仍取默认值', overridden.keys.send);
check(overridden.channel.roomId === '12345', '用户值写入嵌套段', overridden.channel.roomId);
check(provider.stored[SETTINGS_NAMESPACE]?.keys?.record === 'PageUp',
  '用户值被 persist 到存储', JSON.stringify(provider.stored[SETTINGS_NAMESPACE]?.keys));

// --- 3b. 数组字段（模型候选）走通真实设置服务 ---------------------------------
//
// 这一条值得单独验：设置页的「模型」下拉框**候选全部来自这份数组**。数组如果
// 在设置服务这一层被压成字符串、被丢掉、或者默认值根本没铺开，界面就会渲染出
// 一个空下拉框 —— 而那是"看起来像插件坏了"的那类故障，必须在这里拦住。
const defaultOptions = defaults.asr?.modelOptions;
check(Array.isArray(defaultOptions) && defaultOptions.length >= 2,
  'asr.modelOptions 默认值是一个数组', JSON.stringify(defaultOptions));
check(Array.isArray(defaultOptions) && defaultOptions.every((v) => typeof v === 'string'),
  '候选全是字符串（界面直接拿它当 option 文本，混进非字符串会渲染出 undefined）');
check(Array.isArray(defaultOptions) && defaultOptions.includes('Qwen/Qwen3-ASR-1.7B'),
  '候选里有默认模型（否则默认值会是下拉框里的"自定义"）');

await scope.update({ asr: { modelOptions: ['one/model', 'two/model'] } });
const optionsAfter = scope.get().asr?.modelOptions;
check(Array.isArray(optionsAfter) && optionsAfter.join(',') === 'one/model,two/model',
  '用户改写的候选项原样读回（数组能穿过设置服务与存储）', JSON.stringify(optionsAfter));
check(provider.stored[SETTINGS_NAMESPACE]?.asr?.modelOptions?.length === 2,
  '改写的候选项被 persist', JSON.stringify(provider.stored[SETTINGS_NAMESPACE]?.asr?.modelOptions));
check(scope.get().asr?.model === 'Qwen/Qwen3-ASR-1.7B',
  '改候选**不影响**真正生效的模型（候选只是界面上的选项）', scope.get().asr?.model);

// --- 4. 变更广播 -------------------------------------------------------------
let notified = 0;
const stopWatching = scope.watch(() => {
  notified += 1;
});
await scope.update({ overlay: { fontSize: 32 } });
// watch 回调是异步调度的，给它一拍。
await new Promise((r) => setTimeout(r, 50));
check(notified >= 1, 'watch() 收到了变更通知', `收到 ${notified} 次`);
check(scope.get().overlay.fontSize === 32, '变更后的值立刻可读');
stopWatching();

// --- 5. 校验真的拦住写入 -----------------------------------------------------
let rejected = false;
try {
  await scope.update({ keys: { send: 'PageUp' } });   // 与 record 冲突
} catch {
  rejected = true;
}
check(rejected, '跨字段校验拦住了冲突的按键写入');
check(scope.get().keys.send === 'F11',
  '被拒绝的写入没有污染当前值', scope.get().keys.send);

// --- 6. secret 字段 ----------------------------------------------------------
const descriptors = provider.describe({ redactSecrets: true });
const mine = descriptors.find((d) => d.ns === SETTINGS_NAMESPACE);
check(mine !== undefined, 'describe() 能取到本插件的命名空间');
// `path` 是字段路径的**字符串数组**（如 ['asr','apiKey']），不是点分字符串。
const secrets = (mine?.secrets ?? []).map((s) => s.path.join('.'));
check(secrets.includes('asr.apiKey'), 'asr.apiKey 被识别为 secret',
  `secrets=${secrets.join(', ')}`);
// 弹幕通道不再需要凭证，所以现在只有这一个 secret。多出来一个就意味着
// 设置文件里重新出现了可被读走的登录态。
check(secrets.length === 1, '只有一个 secret 字段（弹幕通道不再需要凭证）',
  `secrets=${secrets.join(', ')}`);
// secret 的值本身绝不能出现在描述里——那正是这个机制存在的意义。
const serialized = JSON.stringify(mine);
check(!serialized.includes('SESSDATA') && !serialized.includes('sk-'),
  '描述里不含 secret 的实际值');

console.log(failures === 0
  ? '\n[settings] 设置集成校验全部通过。'
  : `\n[settings] 有 ${failures} 项失败，见上。`);
process.exit(failures === 0 ? 0 : 1);
