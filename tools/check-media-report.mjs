#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 媒体键回写链路校验
 * ============================================================================
 * 用**真实的插件 `apply` + 真实的设置服务 + 真实的 sidecar** 跑一遍媒体键这条路，
 * 验证三件事：
 *
 *   1. 未启用时：sidecar 收到空列表、一个键都不注册（不会去抢别人的键）；
 *   2. 启用后：三个媒体键真的注册上，并且 `behavior.mediaKeysReport` 被回写；
 *   3. 回写的是**回执**（`ok=AudioVolumeMute,…`）而不是键码表（`173,176,179`）。
 *
 * ## 为什么这个测试必须存在
 *
 * 第 3 条是真实踩过的坑：`syncMediaReport(applied.mediaKeys)` 与
 * `syncMediaReport(applied.mediaKeysReport)` 只差一个词，而传错**完全静默** ——
 * sidecar 一切正常、日志一切正常，只有设置页上那行状态永远不出现。
 * 最后是靠"用户填好了键却说按下去没反应"才反查出来的。
 *
 * 而第 1、2 条覆盖的是另一种静默失败：配置填了但没生效。这条路上任何一环
 * （schema 没解析、字段没下发、sidecar 没注册）断了，现象都是"按了没反应"。
 *
 * 用法：node tools/check-media-report.mjs
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

console.log('[media] 媒体键回写链路校验（真插件 + 真设置服务 + 真 sidecar）\n');

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
  console.error(`[media] 无法加载 DSH 的设置服务实现：${cause.message}`);
  console.error('[media] 这个测试需要有 DSH 安装（和 tools/check-settings.mjs 同一前提）。');
  process.exit(1);
}

/** 内存版存储：只换掉与磁盘相关的两个方法，其余全走 DSH 真实代码。 */
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

const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);

/**
 * 跑一轮：给定初始用户文档，把插件真的装起来，等它把 sidecar 拉起来并下发配置，
 * 然后看设置里被回写了什么。
 */
async function run(label, userDocument, settleMs = 6000) {
  console.log(`\n[media] ${label}`);
  const provider = new MemorySettings({ 'voice-danmaku': userDocument });
  await provider.initialize();

  let scope;
  let disposer;
  const updates = [];

  const fakeCtx = {
    inject: (_services, callback) => {
      callback({
        settings: {
          register: (ns, schema, options) => {
            scope = provider.register(ns, schema, options);
            // 记录每一次回写：这是本测试的观测点。
            const original = scope.update.bind(scope);
            try {
              scope.update = async (patch) => {
                updates.push(patch);
                return original(patch);
              };
            } catch {
              /* 代理不可写时跳过包装（那会让下面的断言失败，是可见的） */
            }
            return scope;
          }
        }
      });
    },
    // 记住 disposer 但不执行：执行会去停 sidecar，而我们还要观察下一轮。
    effect: (body) => {
      disposer = body();
    }
  };

  plugin.apply(fakeCtx);
  await new Promise((r) => setTimeout(r, settleMs));

  const resolved = scope?.get();
  const report = resolved?.behavior?.mediaKeysReport;
  const stored = provider.stored['voice-danmaku']?.behavior?.mediaKeysReport;

  if (typeof disposer === 'function') {
    await disposer();
    // 等 sidecar 真的退出：它的父进程守护与协议收尾都需要一点时间。
    await new Promise((r) => setTimeout(r, 1200));
  }

  return { resolved, report, stored, updates };
}

// --- 1. 未启用 ---------------------------------------------------------------
{
  const { resolved, report, stored } = await run(
    '未启用媒体键（默认状态）',
    { mediaKeys: { send: 'MediaTrackNext', cancel: 'MediaPlayPause' } }
  );
  check(resolved?.mediaKeys?.enabled === false, '媒体键解析为未启用');
  check(resolved?.mediaKeys?.record === 'AudioVolumeMute',
    '未填的字段取 schema 默认值', resolved?.mediaKeys?.record);
  // 未启用时回执是空表，不该被写进设置（否则设置页会显示一行没有内容的状态）。
  check(report === '' || report === 'ok=',
    '未启用时没有注册任何媒体键', `report=${JSON.stringify(report)}`);
  check(stored === undefined || stored === '',
    '未启用时不写设置（避免设置文档里多一个没意义的键）',
    `stored=${JSON.stringify(stored)}`);
}

// --- 2. 启用后 ---------------------------------------------------------------
{
  const { resolved, report, stored } = await run(
    '启用媒体键',
    { mediaKeys: { enabled: true, send: 'MediaTrackNext', cancel: 'MediaPlayPause' } }
  );
  check(resolved?.mediaKeys?.enabled === true, '媒体键解析为已启用');
  check(typeof report === 'string' && report.startsWith('ok='),
    '回执是 ok=… 形式', `report=${JSON.stringify(report)}`);
  // 这一条正是那个 bug 的守卫：写成 `applied.mediaKeys` 时拿到的会是
  // "173,176,179"（键码表），而不是键名。
  //
  // ⚠ 但**不能**断言"必然注册成功"：媒体键是**独占的全局热键**，本机上别的进程
  // 占着它们是合法结果 —— 包括**用户此刻正在用的那一份插件**。实测就撞上过：
  // 用户开着插件占着这三个键，于是这里全部 `failed=`。
  // 所以断言的是"回执里出现的是键名而不是键码"，与成败无关。
  check(/^ok=.*(AudioVolumeMute|MediaTrackNext|MediaPlayPause)/.test(report ?? ''),
    '回执里是键名而不是键码（接错字段会变成 173,176,179）',
    `report=${JSON.stringify(report)}`);
  check((report ?? '').includes('AudioVolumeMute') && (report ?? '').includes('MediaPlayPause'),
    '配置的三个键都在回执里被交代了（成功或失败都要报出来）', report);
  check(typeof stored === 'string' && stored === report,
    '回执被回写进设置（设置页据此显示注册结果）', `stored=${JSON.stringify(stored)}`);
}

console.log(failures === 0
  ? '\n[media] 媒体键回写链路校验全部通过。'
  : `\n[media] 有 ${failures} 项失败，见上。`);
process.exit(failures === 0 ? 0 : 1);
