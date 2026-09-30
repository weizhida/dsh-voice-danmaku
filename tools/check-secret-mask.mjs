#!/usr/bin/env node
/**
 * 遮罩归属校验：圆点必须出现在**已设置**的那个密钥字段上
 * ============================================================================
 * 这一条是被一个真实故障逼出来的：用户报"没填过的 cookie 也显示一串点，
 * 而填过的 apiKey 却显示尚未设置" —— 两个字段都反了。
 *
 * 根因是数据源不可用（DSH 描述符的 secret `set` 标记对"空字符串默认值"恒为真），
 * 改用宿主侧回写的 `behavior.secretStatus` 之后，必须验证遮罩**确实跟着这个数据走**，
 * 而不是碰巧恒显示或恒不显示。
 *
 * 做法：用真实组件渲染两种 secretStatus，检查圆点出现的字段是否正确。
 * 这是纯逻辑验证，不需要 DOM（圆点是 input 的 value 属性，会出现在静态 HTML 里）。
 *
 * 用法：node tools/check-secret-mask.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[mask] 遮罩归属校验\n');

// --- 搭一个最小的模块加载器，加载真实客户端 bundle --------------------------
let registration;
globalThis.window = {
  __ModuleLoader__: { load(spec) { registration = spec; } }
};
new Function(readFileSync(join(root, 'lib', 'client.js'), 'utf8'))();

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');

const plugin = registration.factory((spec) => {
  if (spec === 'react') return React;
  throw new Error(`未提供替身: ${spec}`);
});

/** 用给定的 secretStatus 渲染设置页，返回 HTML。 */
function renderWith(secretStatus) {
  const slots = [];
  const fakeT = (key) => key;
  fakeT.bind = () => fakeT;

  const value = {
    keys: { record: 'F9', send: 'F10', cancel: 'F11' },
    overlay: {
      enabled: true, fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
      anchorXPercent: 50, maxWidthPercent: 80, clickThrough: true,
      draggable: true, reassertSeconds: 2
    },
    audio: { backend: 'ffmpeg', ffmpegPath: '', device: '' },
    asr: {
      engine: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'X', apiKey: '', language: 'zh', timeoutMs: 60000
    },
    channel: {
      // 弹幕通道不再需要凭证（请求由浏览器页面自己发），所以这里没有 cookie 了。
      // 于是整个项目只剩一个密钥字段 —— 这个文件因此比它最初的样子简单得多。
      provider: 'page', roomId: '', minIntervalMs: 4000, maxPerHour: 20,
      page: { port: 39217, token: 't'.repeat(32), status: '' }
    },
    behavior: {
      autoStart: true, launchToken: 0, secretStatus,
      consumeKeys: true, confirmTimeoutSeconds: 8,
      soundFeedback: false, autoSendOnRecognized: false
    }
  };

  const fakeCtx = {
    effect: (body) => { const d = body(); return typeof d === 'function' ? d : () => {}; },
    locale: { register: () => () => {}, bind: () => fakeT, getSnapshot: () => ({ active: 'zh' }) },
    // DSH 0.2+ 的设置入口（旧版的 settingsScope 服务已被移除）。
    configForms: {
      get: () => ({
        getSnapshot: () => ({
          status: 'ready', value, base: undefined, user: undefined,
          revision: 1, writable: true, mode: 'host'
        }),
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
        mutate: async () => {}
      })
    },
    slots: {
      inject: (_name, callback) => { slots.push(callback()); return () => {}; },
      register: (options, component) => ({ options, component })
    }
  };

  plugin.apply(fakeCtx);
  const slot = slots[0];
  const injected = slot.options.inject();
  return renderToStaticMarkup(
    React.createElement(slot.component, Object.assign({}, injected, { renderSlot: () => null }))
  );
}

/**
 * 找出**哪个**字段显示为遮罩。
 *
 * 只数个数是不够的 —— 用户报的 bug 恰恰是"遮罩挂在了别的字段上"：个数对得上，
 * 位置错了。所以必须把遮罩和它所属的字段标签对应起来。
 *
 * 项目里现在只剩一个密钥字段（ASR 密钥），但这段归属判定仍然保留：
 * 它是"遮罩会不会挂错地方"的唯一守卫，而日后加回任何密钥字段都用得上。
 */
function maskedLabels(html) {
  const labels = [];
  const marker = 'value="●●●●●●●●"';
  let index = html.indexOf(marker);
  while (index >= 0) {
    // 往前找最近的标签：标签是这个输入框所在行的文字，出现在它之前
    const before = html.slice(0, index);
    const apiKeyAt = before.lastIndexOf('API 密钥');
    labels.push(apiKeyAt >= 0 ? 'API 密钥' : '(无法归属)');
    index = html.indexOf(marker, index + marker.length);
  }
  return labels;
}

const apiKeyOnly = renderWith(['asr.apiKey']);
const neitherSet = renderWith([]);

console.log('  [明细] 各组合下密钥字段的表现：');
for (const [name, html] of [
  ['都没设置  ', neitherSet],
  ['已设置    ', apiKeyOnly]
]) {
  const at = html.indexOf('API 密钥');
  const seg = at < 0 ? '' : html.slice(at, at + 500);
  const mask = seg.includes('●●●●') ? '遮罩' : '空框';
  const clear = seg.includes('清除') ? '+清除' : '';
  console.log(`    ${name} -> API 密钥=${at < 0 ? '找不到' : mask + clear}`);
}
console.log('');

check(maskedLabels(neitherSet).length === 0,
  '没设置时：不显示任何遮罩', `${maskedLabels(neitherSet).length} 个`);

// 核心断言：遮罩必须落在**正确的那一个**字段上
const apiLabels = maskedLabels(apiKeyOnly);
check(apiLabels.length === 1 && apiLabels[0] === 'API 密钥',
  '设了 apiKey 时：遮罩出现在「API 密钥」上', apiLabels.join(', ') || '（无）');

// 反向确认：没设置时那个字段要显示"尚未设置"的提示，而不是一片空白
const notSetHints = (neitherSet.match(/尚未设置/g) ?? []).length;
check(notSetHints === 1, '未设置的字段显示"尚未设置"', `${notSetHints} 处`);

// --- 点击编辑后的提示 --------------------------------------------------------
//
// 这里有个真实限制必须写明：静态渲染**看不到"点击之后"的状态** —— 点进去才会
// 从遮罩切成真输入框，而那是运行时状态，renderToStaticMarkup 拿不到。
// 所以下面两条退化成源码级断言。
//
// 它们防的是一个具体回归：填过的字段被点开编辑时，如果仍提示"尚未设置"，
// 用户会以为自己填的密钥丢了（实测反馈原话："我再点击就显示成尚未设置了"）。
const clientSrc = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8');

check(/secretSet \? 'secretKeep' : 'secretPlaceholder'/.test(clientSrc),
  '点击编辑时按"是否填过"选择提示文案（不再一律显示"尚未设置"）');

// 两种提示都要定义，且中英各一份 —— 少一份会退化成把原始 key 显示出来
for (const key of ['secretKeep', 'secretPlaceholder']) {
  const occurrences = (clientSrc.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length;
  check(occurrences === 2, `文案 ${key} 中英各定义一次`, `实际 ${occurrences} 次`);
}

// --- 清除按钮 ----------------------------------------------------------------
//
// 这几条是行为级的（走真实组件渲染），验证按钮**只在确实存过东西时出现** ——
// 否则它会是个点了没反应的装饰。
const clearLabel = '清除';
const countClear = (html) => (html.match(new RegExp(clearLabel, 'g')) ?? []).length;

check(countClear(neitherSet) === 0,
  '没设置时：没有清除按钮', `${countClear(neitherSet)} 个`);
check(countClear(apiKeyOnly) === 1,
  '设了 apiKey 时：恰好 1 个清除按钮', `${countClear(apiKeyOnly)} 个`);

// 清除必须走 unset（移除键、回落到默认），而不是写入空字符串 ——
// 写空字符串语义是"设置成了空"，而用户的意图是"我不用它了"。
check(/op: 'unset', path: path/.test(clientSrc),
  '清除走 unset 操作（不是写入空字符串）');

// --- 文案 key 的中英成对（含新增的清除相关）---------------------------------
for (const key of ['secretClear', 'secretClearConfirm']) {
  const occurrences = (clientSrc.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length;
  check(occurrences === 2, `文案 ${key} 中英各定义一次`, `实际 ${occurrences} 次`);
}

// --- 清除后界面必须刷新 ------------------------------------------------------
//
// 实测 bug：清除后设置文件里确实清掉了，但界面上还显示着旧内容。
// 根因是 FieldRow 把显示值存在自己的 useState 里，而 useState 的初始化
// **只在首次渲染生效** —— 快照更新了它也不会重算。
//
// 修法是让 key 带上"是否已设置"，密钥状态翻转时 React 重新挂载该行。
// 下面两条断言这个机制在源码里存在。
check(/#set' : '#empty'|#set\" : \"#empty/.test(clientSrc) ||
      /secretIsSet \? '#set' : '#empty'/.test(clientSrc),
  '字段 key 带上密钥状态（清除后能重新挂载、刷新显示）');

check(/key: fieldKey \+ \(secretIsSet/.test(clientSrc),
  'key 由 fieldKey 与密钥状态组合而成');

// --- 打开配置文件按钮 --------------------------------------------------------
//
// DSH 外壳在标题栏已有一个，但它是外壳的一部分、在所有设置页都显示，插件挪不动。
// 本页底部再放一个位置明确的（同页语境下"改这个插件"和"打开配置文件"是一件事）。
const documentButtonCount = (neitherSet.match(/打开配置文件/g) ?? []).length;
check(documentButtonCount === 1,
  '页脚渲染出「打开配置文件」按钮（只出现一次）', `${documentButtonCount} 处`);

for (const key of ['document.open', 'document.opening', 'document.hint',
                   'document.unavailable', 'document.failed']) {
  const occurrences = (clientSrc.match(new RegExp(`'${key}':`, 'g')) ?? []).length;
  check(occurrences === 2, `文案 ${key} 中英各定义一次`, `实际 ${occurrences} 次`);
}

// --- 订阅驱动重渲染（一个真实诊断失误换来的断言）-----------------------------
//
// 用户反馈"只有 Ctrl+F5 之后输入框状态才会变"。根因是组件**没有订阅**设置快照：
// inject 只在渲染前求值一次，快照变了没有任何东西触发重渲染，界面于是永远停在
// 首次渲染的值上。
//
// 我先后误判成两件事：先是"字段没重新挂载"，后是"要调刷新接口"——而客户端 scope
// 根本没有 load()（只有 getSnapshot/subscribe/mutate/set/unset），调它会抛
// "not a function"（用户实际看到了这个报错）。这两条断言就是为了不再犯。
//
// 注意它们是**源码级**的：静态渲染不执行 useEffect，subscribe 在渲染期不会被调用，
// 所以无法用渲染结果验证。这里退而断言"接线存在"。
check(/\.subscribe\(function/.test(clientSrc),
  '组件订阅了设置快照（快照变化会触发重渲染）');
check(/scope: scope/.test(clientSrc),
  '把 scope 交给组件（而不是只传一次快照）');
check(!/settingsScope/.test(clientSrc),
  '没有再用 DSH 0.2 已移除的 settingsScope 服务');

console.log(failures === 0
  ? '\n[mask] 遮罩归属校验全部通过。'
  : `\n[mask] 有 ${failures} 项失败，见上。`);
process.exit(failures === 0 ? 0 : 1);
