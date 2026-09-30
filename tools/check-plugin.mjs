#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 插件契约校验
 * ============================================================================
 * 用一个**假的 cordis 上下文**真正执行一遍插件的 `apply`，验证：
 *
 *   1. 入口导出的契约正确（name / inject / Config / apply）；
 *   2. 设置 schema 能 resolve，且默认值齐全（缺字段是最常见的装配 bug）；
 *   3. 插件真的调用了 `settings.register`，命名空间正确；
 *   4. 按键配置合法，且 schema 校验能拦住"同一个键配了两个动作"；
 *   5. 整个 `apply` 过程不抛异常。
 *
 * 它**不启动 sidecar、不录音、不联网**：那些在 tools/harness.mjs 里单独测。
 * 这里只回答一个问题——"这个插件能被 DSH 正确装上吗"。
 *
 * 用法：node tools/check-plugin.mjs
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = join(root, 'lib', 'index.js');

if (!existsSync(entry)) {
  console.error(`[check] 找不到编译产物 ${entry}`);
  console.error('[check] 先运行：npm run build');
  process.exit(1);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[check] 插件契约校验\n');

const plugin = await import(pathToFileURL(entry).href).catch((cause) => {
  console.error(`[check] 导入入口模块失败：${cause.message}`);
  process.exit(1);
});

// --- 入口契约 ---------------------------------------------------------------
check(plugin.name === 'voice-danmaku', '导出 name', plugin.name);
check(plugin.inject === undefined || !plugin.inject.includes('settings'),
  '不再声明 settings 依赖（0.2 起配置走 cordis 原生 Config）',
  JSON.stringify(plugin.inject));
check(typeof plugin.apply === 'function', '导出 apply 函数');
check(plugin.Config !== undefined && typeof plugin.Config === 'function',
  '导出 Config（schemastery schema）');

// 这一条是整套检查里最要紧的：Host 侧 `dsh-settings` 的 describe() 用
// `volatileForm(schema)` 过滤条目 —— **一个 volatile 字段都没有的插件根本不会进
// 设置镜像**。客户端于是找不到自己的命名空间，界面显示"设置服务当前不可用"，
// 而且没有任何报错，是纯静默失败。
//
// 它也确实非常容易静默失效：插件的本地 schemastery 是 3.18.2、没有 `.volatile()`，
// 只写 `.volatile()` 的实现在真机上拿到的也是这份（link: 安装时 Node 先命中插件
// 自己的 node_modules），标记根本写不上。所以断言要落到**产物**上，而不是
// "我们调用过某个方法"。
check(JSON.stringify(plugin.Config.toJSON()).includes('"volatile":true'),
  'Config schema 里带 volatile 标记（否则不会出现在设置界面里）');

// --- 设置 schema ------------------------------------------------------------
let resolved;
try {
  resolved = new plugin.Config({});
} catch (cause) {
  check(false, '设置 schema 能用空对象 resolve', cause.message);
}

if (resolved !== undefined) {
  check(true, '设置 schema 能用空对象 resolve');
  const sections = ['keys', 'mediaKeys', 'overlay', 'audio', 'asr', 'channel', 'behavior'];
  for (const section of sections) {
    check(resolved[section] !== undefined && typeof resolved[section] === 'object',
      `默认值包含 ${section} 段`);
  }
  check(resolved.keys?.record === 'F9', '默认录音键是 F9', resolved.keys?.record);
  check(resolved.keys?.send === 'F11', '默认发送键是 F11', resolved.keys?.send);
  check(resolved.keys?.cancel === 'F10', '默认取消键是 F10', resolved.keys?.cancel);
  // 媒体键默认关闭：它们是与系统、音乐播放器共享的键，不主动去抢。
  check(resolved.mediaKeys?.enabled === false, '媒体键默认关闭');
  check(resolved.mediaKeys?.record === 'AudioVolumeMute', '默认录音媒体键是静音键',
    resolved.mediaKeys?.record);
  check(resolved.overlay?.clickThrough === true, '浮层默认点击穿透');
  check(resolved.behavior?.consumeKeys === true, '热键默认对游戏隐藏');

  // 密钥字段必须是 secret 角色：否则设置界面会回显登录态。
  // schemastery 的 toJSON() 是一个引用图（`{uid, refs}`），字段之间用数字 id
  // 互相指向，所以必须顺着 refs 走一遍，不能直接当嵌套对象读。
  const schemaJson = typeof plugin.Config.toJSON === 'function' ? plugin.Config.toJSON() : undefined;
  const secrets = schemaJson === undefined ? [] : collectSecretPaths(schemaJson);
  check(secrets.includes('asr.apiKey'), 'API 密钥声明为 secret',
    secrets.length > 0 ? `已声明的 secret 字段: ${secrets.join(', ')}` : '一个都没找到');
  // 弹幕通道不再需要任何凭证（请求由浏览器页面自己发），所以现在**只有**
  // 一个 secret 字段。这条断言防止有人日后又往配置里塞回一个明文凭证 ——
  // 那意味着设置文件里会重新出现可被读走的登录态。
  check(secrets.length === 1, '配置里只有一个密钥字段（弹幕通道不再需要凭证）',
    secrets.join(', ') || '（无）');
}

/**
 * 递归收集所有 `meta.role === 'secret'` 字段的路径。
 *
 * schemastery 的序列化格式是引用图：`{ uid, refs }`，其中 `refs` 是
 * `id -> 节点` 的映射，object 节点用 `dict` 把字段名指向子节点的 id。
 * 所以这里既要在 dict 上按字段名下钻，也要顺着数字 id 解析。
 *
 * @param graph - `toJSON()` 的结果。
 * @returns 形如 `asr.apiKey` 的路径列表。
 */
function collectSecretPaths(graph) {
  const refs = graph?.refs ?? {};
  const found = new Set();

  const walk = (nodeId, prefix, seen) => {
    const node = refs[nodeId];
    if (node === null || typeof node !== 'object') return;
    // 引用图可能成环（自引用 schema），用 seen 断环。
    if (seen.has(nodeId)) return;
    seen.add(nodeId);

    if (node.meta?.role === 'secret' && prefix.length > 0) found.add(prefix);

    const dict = node.dict;
    if (dict !== null && typeof dict === 'object') {
      for (const [field, childId] of Object.entries(dict)) {
        walk(childId, prefix.length > 0 ? `${prefix}.${field}` : field, seen);
      }
    }
  };

  walk(graph?.uid, '', new Set());
  return [...found];
}

// --- 模拟 cordis 上下文，真正跑一遍 apply -----------------------------------
const registered = [];
const injectCalls = [];
let effectRegistered = false;
let watchInstalled = false;

const fakeScope = {
  get: () => resolved,
  watch: () => {
    watchInstalled = true;
    return () => {};
  },
  update: async () => {},
  replace: async () => {}
};

const settingsCtx = {
  settings: {
    register: (ns, schema, options) => {
      registered.push({ ns, schema, options });
      // 顺手验证跨字段校验真的会拒绝冲突配置。
      if (typeof options?.validate === 'function') {
        try {
          options.validate({
            ...resolved,
            keys: { record: 'F9', send: 'F9', cancel: 'F10' }
          });
          check(false, '校验能拦住"同一个键配两个动作"', '冲突配置没有被拒绝');
        } catch {
          check(true, '校验能拦住"同一个键配两个动作"');
        }
        try {
          options.validate({ ...resolved, keys: { record: '不存在的键', send: 'F11', cancel: 'F10' } });
          check(false, '校验能拦住无法识别的按键名');
        } catch {
          check(true, '校验能拦住无法识别的按键名');
        }

        // --- 媒体键 ---------------------------------------------------------
        // 未启用时不校验：默认值是给"打开开关"准备的建议键位，用户没开这个
        // 功能就改不了别的设置是不可接受的。
        try {
          options.validate({
            ...resolved,
            mediaKeys: { enabled: false, record: 'MediaTrackNext', send: 'MediaTrackNext', cancel: 'MediaPlayPause' }
          });
          check(true, '媒体键未启用时不参与校验（默认值不拦人）');
        } catch (cause) {
          check(false, '媒体键未启用时不参与校验（默认值不拦人）', cause.message);
        }
        // 启用后必须拦住重复：两个动作绑同一个键时，哪个生效取决于查表顺序，
        // 表现为"有时候发送、有时候取消"这种几乎无法复现的问题。
        try {
          options.validate({
            ...resolved,
            mediaKeys: { enabled: true, record: 'MediaTrackNext', send: 'MediaTrackNext', cancel: 'MediaPlayPause' }
          });
          check(false, '校验能拦住重复的媒体键');
        } catch {
          check(true, '校验能拦住重复的媒体键');
        }
        // 媒体键名必须真的能被解析：写错名字时启用开关会让热键整条失效。
        try {
          options.validate({
            ...resolved,
            mediaKeys: { enabled: true, record: 'AudioVolumeMute', send: 'MediaTrackNext', cancel: 'MediaPlayPause' }
          });
          check(true, '合法的媒体键配置被接受（AudioVolumeMute/MediaTrackNext/MediaPlayPause）');
        } catch (cause) {
          check(false, '合法的媒体键配置被接受', cause.message);
        }
      }
      return fakeScope;
    }
  }
};

const handledEvents = [];
const fakeCtx = {
  // 记录插件声明的依赖，并**立即**触发回调：真实 cordis 在服务就绪时也会这样调。
  inject: (services, callback) => {
    injectCalls.push(services);
    callback(settingsCtx);
  },
  // 记录清理注册，但不执行（执行会去停一个并不存在的 sidecar）。
  effect: (body) => {
    effectRegistered = true;
    const disposer = body();
    if (typeof disposer !== 'function') {
      check(false, 'effect 回调返回了 disposer 函数');
    }
  },
  // 记录事件订阅。插件靠 `internal/update` 感知配置变更 —— 这是新版 DSH 里
  // "改设置生效"的**唯一**途径（改配置不会重载插件），所以必须记下来并断言，
  // 否则"设置改了没反应"那个 bug 会再回来。
  on: (event, handler) => {
    handledEvents.push({ event, handler });
  }
};

// 新版把配置作为 apply 的**第二个参数**交进来（旧版是插件自己拿去 settings 服务
// 注册）。直接复用上面已经解析好的默认配置 —— 那正是加载器会交给插件的东西。
try {
  plugin.apply(fakeCtx, resolved);
  check(true, 'apply 执行无异常');
} catch (cause) {
  check(false, 'apply 执行无异常', cause.message);
}

// 必须订阅配置更新事件。没有它，用户在设置页做的任何改动都不会生效
// （改配置不重载插件，插件只会在启动时读到一次配置）。
check(handledEvents.some((e) => e.event === 'internal/update'),
  '订阅了配置更新事件（否则改设置不会生效）',
  handledEvents.map((e) => e.event).join(', '));

// 「手动启动」那条路径必须单独跑一遍：上面的默认配置里 `launchToken` 是 0，
// 而只有它变化时插件才会**同步**调用 `startSidecar()` → `launch()`。
//
// 这条断言防的是两个真实故障（都实测发生过）：
//   1. `let launching` 曾被声明在 `launch()` 旁边（函数中段），在初始化之前就被
//      读到 —— 抛 TDZ "Cannot access 'launching' before initialization"；
//   2. 配置更新曾经完全没有被订阅，于是设置页的「启动」按钮点了等于没点。
// 两者合起来的症状就是"随 DSH 启动是好的，但关掉之后点启动没反应"。
try {
  const manualStartConfig = new plugin.Config({ behavior: { launchToken: 1 } });
  plugin.apply(fakeCtx, manualStartConfig);
  check(true, '「手动启动」路径能走通（首次加载即带 launchToken 不抛错）');
} catch (cause) {
  check(false, '「手动启动」路径能走通（首次加载即带 launchToken 不抛错）', cause.message);
}

// 模拟"用户点了设置页的「启动」"：配置更新事件带着新的 launchToken 送进来。
// 首次加载只记基线不启动，所以这次必须真的触发一次启动。
try {
  const updater = handledEvents.find((e) => e.event === 'internal/update');
  if (updater === undefined) {
    check(false, '配置更新能触发手动启动', '没有订阅 internal/update');
  } else {
    updater.handler(new plugin.Config({ behavior: { launchToken: 2 } }));
    check(true, '配置更新能触发手动启动（点「启动」的等价路径）');
  }
} catch (cause) {
  check(false, '配置更新能触发手动启动（点「启动」的等价路径）', cause.message);
}

// 新版的两条硬约束：不再依赖 settings 服务、配置由 cordis 注入。
check(plugin.inject === undefined || !plugin.inject.includes('settings'),
  '不再声明 settings 依赖（0.2 起配置走 cordis 原生 Config）',
  JSON.stringify(plugin.inject));
check(registered.length === 0,
  '没有调用 settings.register（该 API 在新版已不提供服务面）', `实际 ${registered.length} 次`);
check(effectRegistered, '注册了卸载清理逻辑');

// 让插件内部的异步启动有机会安静失败：它找不到 sidecar 时会走"现场编译"，
// 编译产物已存在，所以这里应当是一次成功的启动。
await new Promise((r) => setTimeout(r, 2500));

// ---------------------------------------------------------------------------
// 可选：验证 sidecar 自动重启
// ---------------------------------------------------------------------------
// 这是"进程死了要能自己恢复"这条容错路径的唯一验证方式——否则插件会变成
// "按什么都没反应"的僵尸，而用户不会去看日志。
if (process.argv.includes('--auto-restart')) {
  console.log('\n[check] 验证 sidecar 自动重启：杀掉进程，看它是否自己回来\n');

  const { execFileSync } = await import('node:child_process');
  const killAll = () => {
    try {
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          '(Get-Process -Name dsh-voice-danmaku-sidecar -ErrorAction SilentlyContinue).Id -join ","'],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      for (const pid of output.split(',').filter(Boolean)) {
        try {
          execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore', windowsHide: true });
        } catch {
          /* 可能已经退出了 */
        }
      }
      return output.split(',').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  const killed = killAll();
  check(killed > 0, '找到并杀掉了正在运行的 sidecar', `杀掉 ${killed} 个`);
  // 退避是 1 秒起步，加上进程启动时间，给足余量。
  await new Promise((r) => setTimeout(r, 6000));

  const list = () => {
    try {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          '(Get-Process -Name dsh-voice-danmaku-sidecar -ErrorAction SilentlyContinue).Id -join ","'],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
    } catch {
      return '';
    }
  };
  const after = list().split(',').filter(Boolean);
  check(after.length > 0, 'sidecar 已自动重启', after.length > 0 ? `新 pid=${after.join(',')}` : '没有回来');

  // 收尾：把这个测试拉起的 sidecar 清掉，避免它继续占用全局热键。
  killAll();
}

console.log(failures === 0
  ? '\n[check] 插件契约校验全部通过。'
  : `\n[check] 有 ${failures} 项失败，见上。`);
process.exit(failures === 0 ? 0 : 1);
