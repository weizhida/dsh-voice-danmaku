#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 浏览器半区契约校验
 * ============================================================================
 * 客户端 bundle 是**手写**的（格式由 DSH 运行时加载器规定），所以没有编译器
 * 帮我检查它。`node --check` 只能验证语法，验证不了"它能不能被加载器执行"。
 *
 * 这个脚本模拟加载器的最小契约，真正跑一遍：
 *
 *   1. bundle 以 `window.__ModuleLoader__.load({ id, factory })` 注册自己；
 *   2. factory 收到的 `require` 能解析 react；
 *   3. 工厂返回的模块导出了 name / inject / apply；
 *   4. 用一个假的 ctx 调 apply()：
 *      - 注册了文案字典；
 *      - 往 settings.section 插槽注册了每一页，且 id/label/inject 齐全；
 *   5. **每个页面的组件都能真的渲染出元素树**（用真的 React 渲染逻辑跑一遍）——
 *      这是最容易出错的地方：手写 createElement 时少传 children、
 *      或读了不存在的字段，只有真渲染才暴露得出来。
 *
 * 它替代不了"在浏览器里看一眼"，但能把"必然崩"的那些情况挡在重启之前。
 *
 * 用法：node tools/check-client.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bundlePath = join(root, 'lib', 'client.js');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[client] 浏览器半区契约校验\n');

let source;
try {
  source = readFileSync(bundlePath, 'utf8');
} catch {
  console.error(`[client] 找不到 ${bundlePath}，先运行 npm run build`);
  process.exit(1);
}

// --- 1. 加载器契约 ----------------------------------------------------------
let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registration = spec;
    }
  }
};

// 真正执行 bundle。它只会注册工厂，不产生副作用。
try {
  // 用 Function 而不是 eval：保持独立作用域，同时能拿到全局 window。
  new Function(source)();
  check(true, 'bundle 执行无异常');
} catch (cause) {
  check(false, 'bundle 执行无异常', cause.message);
  process.exit(1);
}

check(registration !== undefined, '调用了 window.__ModuleLoader__.load');
check(registration?.id === 'dsh-voice-danmaku', '注册的模块 id 正确', registration?.id);
check(typeof registration?.factory === 'function', 'factory 是函数');

// --- 2. require 解析 --------------------------------------------------------
// 官方 bundle 就是这样 require react 的；这里用真的 React 跑，才能真渲染。
let React;
try {
  const reactModule = await import('react');
  React = reactModule.default ?? reactModule;
} catch (cause) {
  console.error(`[client] 无法加载 react（校验需要它来真渲染组件）：${cause.message}`);
  process.exit(1);
}

const required = [];
const fakeRequire = (specifier) => {
  required.push(specifier);
  if (specifier === 'react') return React;
  throw new Error(`校验器没有为 ${specifier} 提供替身`);
};

let plugin;
try {
  plugin = registration.factory(fakeRequire);
  check(true, 'factory 执行无异常');
} catch (cause) {
  check(false, 'factory 执行无异常', cause.message);
  process.exit(1);
}

check(required.includes('react'), 'factory 通过 require 取得 react', required.join(', '));
check(plugin?.name === 'voice-danmaku', '导出 name', plugin?.name);
check(Array.isArray(plugin?.inject) && plugin.inject.includes('slots'),
  '导出 inject 且声明依赖 slots', JSON.stringify(plugin?.inject));
check(typeof plugin?.apply === 'function', '导出 apply');

// --- 3. 用假 ctx 跑 apply ---------------------------------------------------
const slots = [];
const localeRegistrations = [];
let effectCount = 0;

const dictionary = {};
/** 被引用但字典里没有的文案 key。界面会显示原始 key，属真实缺陷。 */
const missingStrings = new Set();

const fakeT = (key) => {
  const value = dictionary[key];
  if (value === undefined) missingStrings.add(key);
  return value ?? key;
};
fakeT.bind = () => fakeT;

/**
 * 记录 `t()` 实际被用到的每个 key。
 * 这是"界面会不会露出原始 key"的唯一客观判据：只要某个被用到的 key
 * 不在字典里，组件就会把它原样渲染出来。
 */
const usedStrings = new Set();

const fakeCtx = {
  effect(body) {
    effectCount += 1;
    const disposer = body();
    if (typeof disposer !== 'function') check(false, 'effect 回调应返回 disposer');
    return disposer;
  },
  locale: {
    register(ns, strings) {
      localeRegistrations.push({ ns, strings });
      // 把字典摊平，让 t() 能查到 'groups.keys' / 'fields.keys.record'
      const flatten = (prefix, node) => {
        for (const [key, value] of Object.entries(node)) {
          const path = prefix.length > 0 ? `${prefix}.${key}` : key;
          if (typeof value === 'string') dictionary[path] = value;
          else flatten(path, value);
        }
      };
      flatten('', strings.zh ?? strings.en ?? {});
      return () => {};
    },
    bind: () => fakeT,
    // 客户端现在通过 getSnapshot().active 选择语言；替身要支持它。
    getSnapshot: () => ({ active: 'zh', revision: 1, locales: [] })
  },
  // DSH 0.2+ 的设置入口：`configForms.get(命名空间)` 直接返回 form 控制器。
  // 旧版是 `settingsScope.bind({ namespace })` —— 那个服务在 0.2 里被整个移除，
  // 插件会因为等待它而永远 pending，连带把 web boot 卡死（真实踩过）。
  //
  // 快照形状两版一致（status/value/base/user/revision/writable/mode），
  // 所以这里的替身只需要换入口名，快照内容照旧。
  configForms: {
    get(namespace) {
      boundNamespaces.push(namespace);
      return {
        getSnapshot: () => ({
          status: 'ready',
          value: sampleValue,
          base: undefined,
          user: undefined,
          revision: 1,
          writable: true,
          mode: 'host'
        }),
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
        mutate: async (ops) => { mutations.push(ops); }
      };
    }
  },
  slots: {
    inject(name, callback) {
      const registration_ = callback();
      slots.push(registration_);
      return () => {};
    },
    register(options, component) {
      return { options, component };
    }
  }
};

const boundNamespaces = [];
const mutations = [];
const sampleValue = {
  keys: { record: 'F9', send: 'F11', cancel: 'F10' },
  mediaKeys: {
    enabled: true, record: 'AudioVolumeMute', send: 'MediaTrackNext', cancel: 'MediaPlayPause'
  },
  overlay: {
    enabled: true, fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
    anchorXPercent: 50, maxWidthPercent: 80, clickThrough: true,
    draggable: true, reassertSeconds: 2
  },
  audio: { backend: 'ffmpeg', ffmpegPath: 'ffmpeg' },
  asr: {
    engine: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall', apiKey: '', language: 'zh', timeoutMs: 20000,
    // 下拉候选来自配置，不是写死在界面里。
    //
    // 第三条是**哨兵**：它只出现在这份样例配置里、代码里任何地方都没有。它若能
    // 渲染出来，就证明候选确实是读配置读来的 —— 而不是界面里另存了一份写死的
    // 名单（那样用户改了配置也不会生效，是最难发现的一类错）。
    modelOptions: [
      'FunAudioLLM/SenseVoiceSmall',
      'Qwen/Qwen3-ASR-1.7B',
      'sentinel/only-in-config-9f3c'
    ]
  },
  channel: {
    provider: 'page', roomId: '', minIntervalMs: 4000, maxPerHour: 20, maxLength: 20,
    // 页面通道那一段。status 是宿主回写的联通状态（off/down/waiting/not-ready/
    // page-error/ready 之一），设置页把它翻成一句人话。这里刻意给一个"没连上"的
    // 值，用来验证界面会给出可照做的指引，而不是留一片空白。
    page: { port: 39217, token: 'a'.repeat(32), status: 'waiting' }
  },
  behavior: {
    consumeKeys: true, confirmTimeoutSeconds: 8, soundFeedback: true,
    autoSendOnRecognized: false,
    // 宿主侧回写的"哪些密钥已填写"。apiKey 已设置、cookie 未设置 ——
    // 正是用户遇到的那两种情况，用来验证遮罩不会两边都显示。
    secretStatus: ['asr.apiKey'],
    // 宿主侧回写的媒体键注册结果。刻意造一个"有键没注册上"的情形：
    // 那正是用户会遇到、而且不显示出来就无从排查的情形。
    mediaKeysReport: 'ok=AudioVolumeMute failed=MediaPlayPause'
  }
};

try {
  plugin.apply(fakeCtx);
  check(true, 'apply 执行无异常');
} catch (cause) {
  check(false, 'apply 执行无异常', cause.message);
}

check(localeRegistrations.length === 1, '注册了文案字典', `${localeRegistrations.length} 次`);
check(localeRegistrations[0]?.ns === 'voice-danmaku', '字典命名空间正确');

// 字典必须**中英成对**。locale 服务在当前语言缺 key 时会去查 FALLBACK_LOCALE='en'，
// 所以少一份的后果不是"回退到另一份"，而是界面里冒出英文兜底值。
// 这个断言是为一次真实故障加的：只提供了 zh，结果界面整页英文。
const registeredLocales = Object.keys(localeRegistrations[0]?.strings ?? {});
check(registeredLocales.includes('zh') && registeredLocales.includes('en'),
  '同时提供了 zh 与 en 两份字典（缺一份会落到英文兜底）', registeredLocales.join(', '));

if (registeredLocales.includes('zh') && registeredLocales.includes('en')) {
  const flatKeys = (node, prefix = '') => {
    const out = [];
    for (const [key, value] of Object.entries(node)) {
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (typeof value === 'string') out.push(path);
      else out.push(...flatKeys(value, path));
    }
    return out.sort();
  };
  const zhKeys = flatKeys(localeRegistrations[0].strings.zh);
  const enKeys = flatKeys(localeRegistrations[0].strings.en);
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
  check(onlyZh.length === 0 && onlyEn.length === 0,
    '中英字典的 key 集合完全一致',
    onlyZh.length + onlyEn.length > 0
      ? `不一致: ${[...onlyZh.slice(0, 3), ...onlyEn.slice(0, 3)].join(', ')}`
      : `各 ${zhKeys.length} 个 key`);
}

check(effectCount >= 1, '用 ctx.effect 注册（容器卸载时能清理）');
check(slots.length > 0, '注册了设置页面', `${slots.length} 页`);
check(slots.every((s) => s.options.name === 'settings.section'),
  '注册的插槽名正确');
check(new Set(slots.map((s) => s.options.id)).size === slots.length,
  '每页的 id 唯一（重复 id 会互相覆盖）');
check(slots.every((s) => typeof s.options.label === 'function'),
  '每页都提供 label 函数（导航文字）');
check(slots.every((s) => typeof s.component === 'function'),
  '每页都提供组件');
check(boundNamespaces.every((ns) => ns === 'voice-danmaku'),
  '绑定的设置命名空间正确', boundNamespaces.join(', '));

// --- 4. 真正渲染每一页 ------------------------------------------------------
// 这是本校验的核心：手写的 createElement 树只有真渲染才暴露问题。
const { renderToStaticMarkup } = await import('react-dom/server');

let rendered = 0;
for (const slot of slots) {
  const injected = slot.options.inject();
  try {
    const html = renderToStaticMarkup(
      React.createElement(slot.component, Object.assign({}, injected, { renderSlot: () => null }))
    );
    const hasContent = html.length > 0;
    check(hasContent, `页面「${slot.options.label()}」渲染出内容`,
      hasContent ? `${html.length} 字节` : '渲染结果为空');
    if (hasContent) rendered += 1;
  } catch (cause) {
    check(false, `页面「${slot.options.label()}」渲染成功`, cause.message);
  }
}
check(rendered === slots.length, '所有页面都能渲染', `${rendered}/${slots.length}`);

// --- 5. 文案完整性 ----------------------------------------------------------
// 这一节是两次真实故障换来的。
//
// 第一次：只提供了 zh 一份字典 → locale 服务查不到时回退 en → 界面整页英文。
// 第二次：字典注册在运行时没有生效（写法与官方逐字一致，原因在浏览器侧无法观测）
//         → t() 对每个 key 返回原始 key → 界面显示 "fields.keys.record"。
//
// 所以客户端现在自给自足：文案来自注入的 `copy`，不依赖外部查表。
// 对应地，这里断言两件事：
//   1. 渲染出来的 HTML 里不含任何原始 key；
//   2. `t()` 用到的每个 key 都在 copy 里。
const allHtml = [];
const usedKeys = new Set();
const copyKeys = new Set();

for (const slot of slots) {
  const injected = slot.options.inject();
  // 收集内联字典的 key 集合（copy 就是组件实际会用的那份）
  const flatten = (node, prefix = '') => {
    for (const [key, value] of Object.entries(node ?? {})) {
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (typeof value === 'string') copyKeys.add(path);
      else flatten(value, path);
    }
  };
  flatten(injected.copy);

  // 包一层 t 记录被用到的 key，同时保留原行为。
  // 注意展开顺序：先铺 injected，再覆盖 t —— 反过来会把包装函数冲掉。
  const originalT = injected.t;
  const wrapped = (key) => {
    usedKeys.add(key);
    return originalT(key);
  };
  const html = renderToStaticMarkup(
    React.createElement(slot.component, Object.assign({}, injected, { t: wrapped, renderSlot: () => null }))
  );
  allHtml.push(html);
}

const allText = allHtml.join('');

// 原始 key 的形态：带点的字段路径（fields.x.y / groups.x），以及裸的短 key（nav）。
// 中文字符串不可能匹配这些形态，所以命中即说明有 key 没被翻译。
const leaked = [
  ...new Set([
    ...(allText.match(/(?:fields|groups)\.[a-zA-Z.]+/g) ?? []),
    ...(allText.match(/>\s*(nav|intro|save|saving|saved|secretPlaceholder|hint\w*)\s*</g) ?? [])
      .map((m) => m.replace(/[><\s]/g, ''))
  ])
];
check(leaked.length === 0, '渲染结果里不含任何原始文案 key',
  leaked.length > 0 ? leaked.slice(0, 5).join(', ') : '');

const undefinedUsed = [...usedKeys].filter((key) => !copyKeys.has(key));
check(undefinedUsed.length === 0, '组件用到的每个文案 key 都在字典里',
  undefinedUsed.length > 0
    ? undefinedUsed.slice(0, 5).join(', ')
    : `用到 ${usedKeys.size} 个 key`);
check(missingStrings.size === 0, '没有出现未定义的文案',
  missingStrings.size > 0 ? [...missingStrings].slice(0, 5).join(', ') : '');

// 导航标签必须是可读文字（它是用户在左侧列表里看到的唯一线索）
const navLabels = slots.map((s) => s.options.label());
check(navLabels.every((label) => label.length > 0 && !/^[a-z.]+$/.test(label)),
  '导航标签是已翻译的文案', navLabels.join(', '));

// --- 6. 交互状态的静态守卫 --------------------------------------------------
//
// 这一节来自一个真实故障：顶部控制条最初这样读值 ——
//     var autoStartValue = readPath(snapshot.value, ['behavior','autoStart'])
// 于是点复选框时草稿确实写进去了，但复选框仍按"已保存的值"渲染，
// 视觉上毫无变化。用户看到的是"点了没反应，怎么点都打不上勾"。
//
// 这类 bug 有个特点：**渲染结果完全正常，只有交互不对** —— 所以上面那些
// 快照渲染断言一个都抓不住它。而没有 DOM 环境就无法真的"点击"，
// 所以这里退一步做静态检查：断言控件读值必须经过 effective()。
//
// 它比行为测试弱，但它精确对准这个 bug 的模式，且零依赖。
const clientSource = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8');

check(/var effective = function/.test(clientSource),
  '定义了 effective()：先看草稿、再看已保存值');

// 控制条与字段行都必须拿到 effective，而不是自读 snapshot.value
check(/effective: effective/.test(clientSource),
  'FieldRow 通过 props.effective 取显示值（不直接读 snapshot.value）');
check(/autoStartValue = effective\(/.test(clientSource) ||
      /var autoStartValue = effective\(/.test(clientSource),
  '顶部开关的勾选状态来自 effective()');

// 说明为什么这里只做正向断言：
//
// effective() 的实现里**必然**有一句 readPath(snapshot.value, path) —— 那是它的
// 回退分支，是正确的。所以"禁止出现 readPath(snapshot.value)"这种反向检查会
// 误报（我加过一次，当场被自己的实现对上了）。而且它也无法区分"在 effective 里"
// 和"在控件里"，所以不做。
// 上面三条正向断言已经覆盖了这个 bug 的模式：控件必须经由 effective 取显示值。

// --- 7. 已保存密钥的遮罩 ----------------------------------------------------
//
// 用户的诉求是"我看不出自己填过没有"。宿主只下发"设没设过"、不下发值，
// 所以界面用遮罩圆点表示"存过了"。这里断言它确实出现在渲染结果里 ——
// 否则用户看到的还是空框，问题等于没解决。
const renderedHtml = allHtml.join('');
check(renderedHtml.includes('●●●●'),
  '已设置的密钥显示为遮罩圆点（用户能看出"填过"）');
check(!renderedHtml.includes('SESSDATA') && !renderedHtml.includes('sk-'),
  '渲染结果里不含任何密钥明文');

// --- 8. 媒体键 --------------------------------------------------------------
//
// ⚠️ 这里原来检查"媒体键行带捕获按钮"（点按钮、再按一下媒体键自动填入）。
// 那个设计**原理上走不通**，已整体移除：媒体键走 HID Consumer Control
// （用途页 0x0C），由系统用 `RegisterHotKey` 派发，**浏览器收不到这些键的
// keydown**（否则任何网页都能劫持你的播放/暂停键）。实测表现就是点了按钮
// 显示"等待按键…"，然后按什么都没反应。
//
// 所以断言反过来：三个媒体键都是纯文本输入，且不能再出现捕获按钮 —— 免得哪天
// 那段 UI 被重新加回来，而它只会静默地不工作。
check(!renderedHtml.includes('按一下媒体键') && !renderedHtml.includes('等待按键'),
  '媒体键行没有捕获按钮（浏览器收不到媒体键，那个按钮不会工作）');
check(!/field\.capture/.test(clientSource) && !/mediaKeyFromEvent/.test(clientSource),
  '客户端没有残留的捕获代码');

// 注册失败是静默的（键被别的程序占用），必须显示出来，否则用户只会看到
// "按这个键没反应"而没有任何线索。
check(renderedHtml.includes('MediaPlayPause') && renderedHtml.includes('未注册'),
  '媒体键注册失败会显示在设置页上');

// 总开关没打开时必须给出警告。这一条来自一次真实的排查：用户填好了键、点了保存、
// 按下去毫无反应 —— 因为总开关没打开，而界面上没有任何地方说明"不打开就不生效"。
check(/effective\(\['mediaKeys', 'enabled'\]\) !== true/.test(clientSource),
  '总开关没打开时给出警告（不是静默失效）');
// 复选框的勾选状态必须现读 effective()：本地 state 只在挂载时取值，
// 别处改了同一字段之后它会停在"看起来没打开"的样子。
check(/checked: effective\(field\.path\) === true/.test(clientSource),
  '复选框的勾选状态在渲染时现读（别处改了同一字段也能跟着变）');

// --- 9. 发送通道：两种方式切换 ----------------------------------------------
//
// 这一节验证的是"界面会不会骗人"。发送通道曾经有两条（插件自己发 HTTP 请求 /
// 浏览器页面发），现在只剩后者 —— 所以这里断言那套东西**真的消失**了：
// 留着一个"发送方式"下拉框或者 Cookie 输入框，用户就会以为还有别的选择、
// 或者以为要填凭证。
let channelHtml = '';
try {
  const injected = slots[0].options.inject();
  channelHtml = renderToStaticMarkup(
    React.createElement(slots[0].component, Object.assign({}, injected, { renderSlot: () => null }))
  );
  check(true, '发送通道那一节能正常渲染');
} catch (cause) {
  check(false, '发送通道那一节能正常渲染', cause.message);
}

check(!/Cookie/i.test(channelHtml), '界面上不再有任何 Cookie 字段（那条通道已删除）');
check(!/发送方式|Delivery method/.test(channelHtml),
  '不再显示「发送方式」下拉框（只剩一条通道，摆着它只是噪音）');
check(channelHtml.includes('本地桥端口') && channelHtml.includes('本地桥口令'),
  '页面通道的端口与口令字段都在');
check(channelHtml.includes('39217'), '显示本地桥端口的值');
check(channelHtml.includes('a'.repeat(32)), '显示本地桥口令（要复制到扩展里）');
check(channelHtml.includes('扩展还没连上来'), '显示"扩展没连上"的具体指引（不是静默失效）');

// --- 10. ASR 模型：候选 + 自定义 --------------------------------------------
//
// 这里换过一次实现，两边的教训都值得留着：
//
//   * 一开始是纯文本字段 —— 用户得手打一长串模型名；
//   * 改成 `<datalist>` 之后**更糟**：它把输入框当搜索框用，框里已经有值时下拉
//     只显示匹配当前值的那一个，用户的原话是"选哪个下拉框就只能看到哪个"。
//
// 现在是真正的下拉框（候选一眼看全）+ 一个「自定义…」入口。后者是为了不把范围
// 钉死 —— 服务商上了新模型，用户不该等插件更新。
//
// 候选名单本身则是**配置项**（`asr.modelOptions`）：用户想加/删一个模型，进配置
// 文件改一行就行，不必改代码、也不必等插件更新。界面上刻意不给它输入框 —— 它是
// "配置文件的配置"，混进来只会让设置页更长。
check(/kind: 'choice'/.test(clientSource), '模型字段用「候选 + 自定义」');
check(/optionsPath: \['asr', 'modelOptions'\]/.test(clientSource),
  '候选名单指向配置项 asr.modelOptions（不是界面里写死的数组）');
check(renderedHtml.includes('sentinel/only-in-config-9f3c'),
  '候选来自配置：只存在于样例配置里的哨兵模型被渲染出来了');
check(renderedHtml.includes('Qwen/Qwen3-ASR-1.7B'), '候选里有默认模型');
check(/<select/.test(renderedHtml), '渲染成真正的下拉框（能一眼看全所有候选）');
check(renderedHtml.includes('自定义'), '带「自定义…」入口（候选之外的模型也能填）');
check(!/<datalist/.test(renderedHtml),
  '不再用 datalist —— 它只显示匹配当前输入的那一个选项');

console.log(failures === 0
  ? `\n[client] 浏览器半区契约校验全部通过（${slots.length} 个设置页面）。`
  : `\n[client] 有 ${failures} 项失败，见上。`);
process.exit(failures === 0 ? 0 : 1);
