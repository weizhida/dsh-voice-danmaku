#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 生成类型检查配置
 * ============================================================================
 * 为什么需要这一步，而不是提交一个现成的 tsconfig.check.json：
 *
 * 本插件的类型检查要对着 **DSH 真实的类型定义**跑（这样"我用的 API 签名对不对"
 * 才有意义）。而那些定义在用户机器上的 DSH 安装目录里，路径因人而异。
 *
 * 如果把带绝对路径的配置提交进仓库，对任何其他人都是坏的——CI 上会找不到文件，
 * 报出一堆"模块不存在"，看起来像代码错误，实际是配置错误。所以：
 *
 *   * `tsconfig.check.example.json` 提交进仓库，说明这个配置的形状；
 *   * 本脚本按**当前机器**的实际路径生成 `tsconfig.check.json`（已 gitignore）；
 *   * 找不到 DSH 安装时给出明确提示，而不是生成一个坏配置。
 *
 * 查找顺序：
 *   1. $DSH_HOME/node_modules
 *   2. $USERPROFILE/.dsh/profiles/node_modules
 *   3. $DSH_ROOT/node_modules（源码检出时的布局）
 *   4. 从全局 npm 根目录找 @deepseek-ai/dsh/node_modules
 *
 * 用法：node tools/gen-tsconfig.mjs
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outPath = join(root, 'tsconfig.check.json');

/** 我们需要的三个类型定义包，以及它们的类型入口。 */
const REQUIRED = [
  { pkg: '@deepseek-ai/cordis', entry: 'lib/types/index.d.ts' },
  { pkg: '@deepseek-ai/schemastery', entry: 'lib/types/index.d.ts' },
  { pkg: '@deepseek-ai/dsh-settings', entry: 'lib/types/index.d.ts' }
];

/** 候选的 node_modules 目录，按可信度排序。 */
function candidateRoots() {
  const roots = [];
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';

  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'node_modules'));
  if (home) roots.push(join(home, '.dsh', 'profiles', 'node_modules'));
  if (process.env.DSH_ROOT) roots.push(join(process.env.DSH_ROOT, 'node_modules'));

  // 全局 npm 根：本机就是这样装的 DSH。
  const npmGlobal = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules')
    : '';
  if (npmGlobal) {
    roots.push(join(npmGlobal, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
  }

  return roots.filter((dir) => dir.length > 0);
}

/**
 * 在一个 node_modules 目录下检查所需包是否齐全。
 * 注意全局 npm 根那个候选目录已经把 @deepseek-ai 拼进路径了，
 * 所以这里两种布局都试一下。
 */
function resolveIn(base) {
  for (const prefix of [base, join(base, '@deepseek-ai')]) {
    const paths = {};
    let allFound = true;
    for (const { pkg, entry } of REQUIRED) {
      const packageDir = join(prefix, pkg.replace('@deepseek-ai/', ''));
      const entryPath = join(packageDir, entry);
      if (!existsSync(entryPath)) {
        allFound = false;
        break;
      }
      paths[pkg] = entryPath;
    }
    if (allFound) return paths;
  }
  return undefined;
}

/** 找到一套可用的类型定义。 */
function findTypePaths() {
  for (const base of candidateRoots()) {
    if (!existsSync(base)) continue;
    const paths = resolveIn(base);
    if (paths !== undefined) return { base, paths };
  }
  return undefined;
}

const found = findTypePaths();

if (found === undefined) {
  console.error('[gen-tsconfig] 没找到 DSH 的类型定义，无法生成类型检查配置。');
  console.error('');
  console.error('  类型检查需要一份已安装的 DeepSeek Harness（用它自己的类型定义来校验）。');
  console.error('  查找过的位置：');
  for (const base of candidateRoots()) console.error(`    ${base}`);
  console.error('');
  console.error('  如果 DSH 装在别处，用环境变量告诉本脚本：');
  console.error('    $env:DSH_HOME = "D:\\path\\to\\.dsh"     # 或');
  console.error('    $env:DSH_ROOT = "D:\\path\\to\\dsh"      # 源码检出目录');
  console.error('');
  console.error('  只是不想做类型检查的话，跳过即可：');
  console.error('    npm run build && npm run test:unit    # 其余校验都不依赖 DSH');
  process.exit(1);
}

// 用正斜杠：JSON 里的 Windows 路径用反斜杠需要转义，容易写错。
const toPosix = (p) => p.replace(/\\/g, '/');

const config = {
  extends: './tsconfig.json',
  compilerOptions: {
    noEmit: true,
    types: ['node'],
    baseUrl: '.',
    paths: Object.fromEntries(
      Object.entries(found.paths).map(([pkg, path]) => [pkg, [toPosix(path)]])
    )
  }
};

writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log('[gen-tsconfig] 已生成 tsconfig.check.json');
console.log(`[gen-tsconfig] 类型定义来源: ${found.base}`);
for (const [pkg, path] of Object.entries(found.paths)) {
  console.log(`[gen-tsconfig]   ${pkg} -> ${toPosix(path).replace(toPosix(root), '.')}`);
}
