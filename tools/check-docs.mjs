#!/usr/bin/env node
/**
 * 文档与代码的一致性巡检。
 * ============================================================================
 * 文档里最容易腐烂的两类东西：
 *
 *   1. **目录结构清单**（architecture.md 那份）—— 加了文件忘了写，或者删了文件
 *      还留着，读的人会去找一个不存在的东西；
 *   2. **命令清单**（README 的校验表）—— 改了脚本名，文档还指着旧名字。
 *
 * 两者都不会让测试失败，所以只能专门检查。这里做的是最低成本的版本：
 * 把文档里出现的 `src/xxx.ts`、`sidecar/src/xxx.cs`、`npm run xxx` 抽出来，
 * 与磁盘上的实际文件/npm scripts 对照。
 *
 * 用法：node tools/check-docs.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('[docs] 文档一致性巡检\n');

const read = (relative) => readFileSync(join(root, relative), 'utf8');
const scriptNames = new Set(
  Object.keys(JSON.parse(read('package.json')).scripts ?? {})
);

// --- 1. README 里提到的 npm 脚本都真实存在 --------------------------------
const docFiles = ['README.md', 'CONTRIBUTING.md', 'docs/architecture.md', 'docs/protocol.md'];
const missingScripts = new Set();

for (const file of docFiles) {
  if (!existsSync(join(root, file))) continue;
  const text = read(file);
  for (const match of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
    const name = match[1].replace(/[:.]$/, '');
    if (!scriptNames.has(name)) missingScripts.add(`${file}: ${name}`);
  }
}
check(missingScripts.size === 0, '文档里提到的 npm 脚本都存在',
  [...missingScripts].join(', '));

// --- 2. 反向：常用脚本都在文档里出现过 --------------------------------------
// 只查"用户要用的"那几个，不做全量：test:unit 之类的实现细节不必都写进 README。
const documented = docFiles.map((f) => (existsSync(join(root, f)) ? read(f) : '')).join('\n');
const userFacing = ['build', 'build:all', 'build:sidecar', 'test', 'typecheck',
  'verify:hotkey', 'verify:media', 'demo:overlay', 'test:asr'];
const undocumented = userFacing.filter((name) => scriptNames.has(name) &&
  !documented.includes(`npm run ${name}`));
check(undocumented.length === 0, '面向用户的脚本都写进了文档', undocumented.join(', '));

// --- 3. 架构文档的目录清单与实际文件对得上 ----------------------------------
const architecture = read('docs/architecture.md');
const listed = [...architecture.matchAll(/(?:^|\s)([\w./-]+\.(?:ts|mjs|cs|md|js|yml|json))/gm)]
  .map((m) => m[1]);
// 只校验带目录的路径：裸文件名（harness.mjs）在文档里是"名字"而不是"路径"。
const withDir = [...new Set(listed.filter((p) => p.includes('/')))];

/**
 * 文档里的相对路径有两种写法：从仓库根算（`src/keys.ts`）和从所在子目录算
 * （目录清单里的 `src/Program.cs` 其实是 `sidecar/src/Program.cs`）。
 * 两种都合理，所以只要在任一常见前缀下存在就算对 —— 这一条检查的目的是
 * **抓出真正写错/已删除的文件**，不是规定标点。
 */
const pathExists = (p) =>
  [p, `sidecar/${p}`, `src/${p}`, `tools/${p}`, `docs/${p}`]
    .some((candidate) => existsSync(join(root, candidate)));

const brokenPaths = withDir.filter((p) => !pathExists(p));
check(brokenPaths.length === 0, `架构文档里的路径都存在（${withDir.length} 个）`,
  brokenPaths.join(', '));

// --- 3b. 目录清单里的**文件名**也都存在 --------------------------------------
// 这一条比上一条重要：目录清单大半是裸文件名（`index.ts`、`machine.ts`），
// 而"文档里列着一个已经删掉/改名的文件"正是最容易发生、也最误导人的腐烂。
// 它抓到过一次真实的：清单里写着 `overlay.ts`，而那个文件早已并回 index.ts。
const sourceNames = new Set();
const collect = (dir) => {
  const full = join(root, dir);
  if (!existsSync(full)) return;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) collect(join(dir, entry.name));
    else sourceNames.add(entry.name);
  }
};
for (const dir of ['src', 'sidecar', 'tools', 'test', 'docs', '.github']) collect(dir);

const mentionedNames = [...new Set(
  [...architecture.matchAll(/\b([\w-]+\.(?:ts|cs|mjs))\b/g)].map((m) => m[1])
)];
const unknownNames = mentionedNames.filter((name) => !sourceNames.has(name));
check(unknownNames.length === 0,
  `架构文档提到的源文件名都存在（${mentionedNames.length} 个）`, unknownNames.join(', '));

// --- 4. 文档里的协议字段名与代码对得上 --------------------------------------
// 协议文档是跨进程契约，字段名写错比路径写错更隐蔽：读的人照着写就对不上。
const protocol = read('docs/protocol.md');
const protocolFields = ['mediaKeys', 'mediaKeysReport', 'consumeKeys', 'source', 'heldMs'];
const sidecarSource = read('sidecar/src/Program.cs');
const clientSource = read('src/sidecar-client.ts');
const missingFields = protocolFields.filter((field) =>
  !protocol.includes(field) || (!sidecarSource.includes(field) && !clientSource.includes(field)));
check(missingFields.length === 0,
  '协议文档里的关键字段在两侧代码里都存在', missingFields.join(', '));

console.log(failures === 0
  ? '\n[docs] 文档与代码一致。'
  : `\n[docs] 有 ${failures} 项不一致，见上。`);
process.exit(failures === 0 ? 0 : 1);
