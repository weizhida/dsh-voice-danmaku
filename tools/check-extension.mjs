#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— Chrome 扩展的静态检查
 * ============================================================================
 * 扩展是**手写的 JS**，没有编译器、没有类型检查，而且它跑在浏览器里 ——
 * 出错时插件那边只会看到"按了没反应"。所以这里把能在本地查的都查掉：
 *
 *   1. manifest 能解析，必需字段齐全，MV3；
 *   2. manifest 引用的每个文件都真的存在（改文件名忘了改 manifest 是最常见的错）；
 *   3. 每个脚本语法正确（用 Function 构造器编译一遍，不执行）；
 *   4. **权限最小化**：只匹配 bilibili 的直播间页面、只访问回环地址。
 *      这一条是刻意加的守卫：某天有人为了图方便把匹配范围放宽到所有网站，
 *      扩展就会要求读取你访问的一切 —— 对一个"帮你发弹幕"的工具来说，
 *      那个权限本身不可接受，而且会让用户有充分理由不敢装。
 *
 * 用法：node tools/check-extension.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extensionDir = join(root, 'extension');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[extension] Chrome 扩展静态检查\n');

// --- 1. manifest -------------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  check(true, 'manifest.json 能解析');
} catch (cause) {
  check(false, 'manifest.json 能解析', cause.message);
  process.exit(1);
}

check(manifest.manifest_version === 3, '是 Manifest V3', String(manifest.manifest_version));
check(typeof manifest.name === 'string' && manifest.name.length > 0, '有名字', manifest.name);
check(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version),
  '版本号形如 x.y.z', manifest.version);
check(typeof manifest.description === 'string' && manifest.description.length > 20,
  '有说明文字（用户装之前只能看这个）');

// --- 2. 引用完整性 -----------------------------------------------------------
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? [])
].filter((value) => typeof value === 'string');

const missing = referenced.filter((file) => !existsSync(join(extensionDir, file)));
check(missing.length === 0, `manifest 引用的 ${referenced.length} 个文件都存在`, missing.join(', '));

// --- 3. 语法 -----------------------------------------------------------------
const scripts = referenced.filter((file) => file.endsWith('.js'));
const broken = [];
for (const file of scripts) {
  const source = readFileSync(join(extensionDir, file), 'utf8');
  try {
    // Function 构造器只编译不执行 —— 正好用来查语法，而且不需要开子进程
    // （受限环境下 spawn 可能被拦，那是这个项目踩过的坑）。
    // eslint-disable-next-line no-new-func
    new Function(source);
  } catch (cause) {
    broken.push(`${file}: ${cause.message}`);
  }
}
check(broken.length === 0, `${scripts.length} 个脚本语法正确`, broken.join('; '));

// --- 4. 权限最小化 -----------------------------------------------------------
const matches = (manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []);
check(matches.length > 0, '声明了内容脚本的匹配范围', matches.join(', '));
check(matches.every((pattern) => !pattern.includes('<all_urls>')),
  '没有申请 <all_urls>（那等于读取你访问的所有网站）', matches.join(', '));
check(matches.every((pattern) => /bilibili\.com/.test(pattern)),
  '只匹配 bilibili 域名', matches.join(', '));

const hosts = manifest.host_permissions ?? [];
check(hosts.every((pattern) => /^https?:\/\/(127\.0\.0\.1|localhost)[/:]/.test(pattern)),
  '只访问回环地址（插件与扩展都在这台机器上）', hosts.join(', '));
check(hosts.some((pattern) => pattern.startsWith('http://127.0.0.1')),
  '包含 http://127.0.0.1（本地桥就在那里）', hosts.join(', '));

const permissions = manifest.permissions ?? [];
check(permissions.every((name) => name === 'storage'),
  '只申请了 storage 权限', permissions.join(', ') || '（无）');

// --- 5. 内容脚本的注入世界 ---------------------------------------------------
const worlds = (manifest.content_scripts ?? []).map((entry) => entry.world ?? 'ISOLATED');
check(worlds.includes('MAIN'),
  '有一个跑在页面世界（MAIN）的脚本 —— 只有它能包住页面自己的 fetch',
  worlds.join(', '));
check(worlds.includes('ISOLATED'),
  '有一个跑在隔离世界（ISOLATED）的脚本 —— 只有它能用 chrome.* API',
  worlds.join(', '));

// --- 6. 关键的实现约束（静态守卫）-------------------------------------------
const contentSource = readFileSync(join(extensionDir, 'content.js'), 'utf8');
const backgroundSource = readFileSync(join(extensionDir, 'background.js'), 'utf8');

// 网络必须由 service worker 发：MV3 里内容脚本的跨域请求受页面 CORS 约束。
check(!/fetch\(/.test(contentSource.replace(/\/\*[\s\S]*?\*\//g, '')),
  '内容脚本里没有直接的 fetch（MV3 下它连不上本机端口）');
check(/fetch\(/.test(backgroundSource), '网络请求在 service worker 里');

// 输入框里有内容时不许覆盖：丢掉用户已经打的字比这次没发出去糟得多。
check(/existing\.length > 0/.test(contentSource),
  '输入框非空时拒绝发送（不覆盖用户已经打的字）');

console.log(failures === 0
  ? '\n[extension] 扩展静态检查全部通过。'
  : `\n[extension] 有 ${failures} 项失败，见上。`);
process.exit(failures === 0 ? 0 : 1);
