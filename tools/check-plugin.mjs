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
check(Array.isArray(plugin.inject) && plugin.inject.includes('settings'),
  '导出 inject 且声明依赖 settings', JSON.stringify(plugin.inject));
check(typeof plugin.apply === 'function', '导出 apply 函数');
check(plugin.Config !== undefined && typeof plugin.Config === 'function',
  '导出 Config（schemastery schema）');

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
  check(resolved.keys?.send === 'F10', '默认发送键是 F10', resolved.keys?.send);
  check(resolved.keys?.cancel === 'F11', '默认取消键是 F11', resolved.keys?.cancel);
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
            keys: { record: 'F9', send: 'F9', cancel: 'F11' }
          });
          check(false, '校验能拦住"同一个键配两个动作"', '冲突配置没有被拒绝');
        } catch {
          check(true, '校验能拦住"同一个键配两个动作"');
        }
        try {
          options.validate({ ...resolved, keys: { record: '不存在的键', send: 'F10', cancel: 'F11' } });
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
            mediaKeys: { enabled: false, record: 'MediaPlayPause', send: 'MediaPlayPause', cancel: 'MediaTrackNext' }
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
            mediaKeys: { enabled: true, record: 'MediaPlayPause', send: 'MediaPlayPause', cancel: 'MediaTrackNext' }
          });
          check(false, '校验能拦住重复的媒体键');
        } catch {
          check(true, '校验能拦住重复的媒体键');
        }
        // 媒体键名必须真的能被解析：写错名字时启用开关会让热键整条失效。
        try {
          options.validate({
            ...resolved,
            mediaKeys: { enabled: true, record: 'AudioVolumeMute', send: 'MediaPlayPause', cancel: 'MediaTrackNext' }
          });
          check(true, '合法的媒体键配置被接受（AudioVolumeMute/MediaPlayPause/MediaTrackNext）');
        } catch (cause) {
          check(false, '合法的媒体键配置被接受', cause.message);
        }
      }
      return fakeScope;
    }
  }
};

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
  }
};

try {
  plugin.apply(fakeCtx);
  check(true, 'apply 执行无异常');
} catch (cause) {
  check(false, 'apply 执行无异常', cause.message);
}

check(injectCalls.some((list) => list.includes('settings')),
  'apply 里声明了对 settings 的依赖');
check(registered.length === 1, '调用了 settings.register 一次', `实际 ${registered.length} 次`);
check(registered[0]?.ns === 'voice-danmaku', '设置的命名空间正确', registered[0]?.ns);
check(registered[0]?.options?.applies === 'live',
  '声明为 live 生效（改设置不需要重启）', registered[0]?.options?.applies);
check(watchInstalled, '安装了设置变更监听（改按键能立即生效）');
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
