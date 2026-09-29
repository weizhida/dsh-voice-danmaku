#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— sidecar 构建脚本
 * ============================================================================
 * 把 sidecar/src/*.cs 编译成 sidecar/bin/dsh-voice-danmaku-sidecar.exe。
 *
 * 设计取舍：**不用 .NET SDK，用 Windows 自带的 .NET Framework csc.exe。**
 *   * 优点：零安装成本。Windows 自带 csc，终端用户不需要装 dotnet SDK，
 *     也不需要 Visual Studio。产物是单文件 exe，仓库里不放二进制。
 *   * 代价：只能用到 .NET Framework 的 API（对本项目完全够用，我们只用
 *     WinForms + Win32 P/Invoke + 基础 BCL）。
 *
 * csc 的查找顺序：
 *   1. 环境变量 CSC（给想用 Roslyn 的人留的口子）
 *   2. .NET Framework 4.x 各版本目录，优先 64 位
 *
 * 用法：
 *   node sidecar/build.mjs            编译
 *   node sidecar/build.mjs --check    只查找编译器并打印，不编译
 *   node sidecar/build.mjs --debug    带调试符号
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(here, 'src');
const outDir = join(here, 'bin');
const outExe = join(outDir, 'dsh-voice-danmaku-sidecar.exe');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const withDebug = args.has('--debug');

/** 在 .NET Framework 安装目录里找 csc.exe。 */
function findCompiler() {
  if (process.env.CSC) {
    if (!existsSync(process.env.CSC)) {
      throw new Error(`CSC 环境变量指向的文件不存在: ${process.env.CSC}`);
    }
    return process.env.CSC;
  }

  const windowsDir = process.env.WINDIR ?? 'C:\\Windows';
  const frameworkRoot = join(windowsDir, 'Microsoft.NET', 'Framework64');
  const fallbackRoot = join(windowsDir, 'Microsoft.NET', 'Framework');

  for (const base of [frameworkRoot, fallbackRoot]) {
    if (!existsSync(base)) continue;
    // v4.0.30319 是 .NET Framework 4.x 的固定目录；按版本号倒序取最新的一个。
    const candidates = readdirSync(base)
      .filter((name) => /^v\d/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of candidates) {
      const csc = join(base, version, 'csc.exe');
      if (existsSync(csc)) return csc;
    }
  }
  return null;
}

/** 递归收集 .cs 源文件。 */
function collectSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectSources(full));
    else if (entry.endsWith('.cs')) found.push(full);
  }
  return found;
}

/** 定位 .NET Framework 的引用程序集目录（csc 需要它的元数据，不需要运行时）。 */
function findReferenceAssemblies() {
  const windowsDir = process.env.WINDIR ?? 'C:\\Windows';
  const candidates = [
    join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
    join(windowsDir, 'Microsoft.NET', 'Framework', 'v4.0.30319'),
    // 装了 .NET Framework 4.8 SDK / VS 时的引用程序集位置。
    'C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.8',
    'C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.7.2'
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'System.Windows.Forms.dll'))) return dir;
  }
  return null;
}

function main() {
  const csc = findCompiler();
  if (!csc) {
    console.error('[sidecar] 找不到 C# 编译器 (csc.exe)。');
    console.error('  Windows 通常自带于 C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
    console.error('  也可以安装 .NET Framework 4.x，或设置 CSC 环境变量指向任意 csc。');
    process.exit(1);
  }

  const referenceDir = findReferenceAssemblies();
  if (!referenceDir) {
    console.error('[sidecar] 找不到 .NET Framework 引用程序集目录。');
    process.exit(1);
  }

  const sources = collectSources(srcDir).sort();
  if (sources.length === 0) {
    console.error(`[sidecar] ${srcDir} 下没有 .cs 源文件。`);
    process.exit(1);
  }

  console.log(`[sidecar] 编译器     : ${csc}`);
  console.log(`[sidecar] 引用程序集 : ${referenceDir}`);
  console.log(`[sidecar] 源文件     : ${sources.length} 个`);
  for (const file of sources) console.log(`           - ${file.slice(root.length + 1)}`);

  if (checkOnly) {
    console.log('[sidecar] --check 模式，不编译。');
    return;
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const cscArgs = [
    '/nologo',
    // 关键：csc 默认按系统 ANSI 代码页读源码，而本项目的源文件是 UTF-8
    // （含中文注释与中文字面量）。不指定这一项，编译出的中文字符串会变成乱码。
    '/codepage:65001',
    // winexe：无控制台窗口。stdio 仍然可用（我们在 Program.cs 里显式打开标准流）。
    '/target:winexe',
    '/platform:anycpu',
    '/langversion:5',
    '/optimize+',
    withDebug ? '/debug:full' : '/debug-',
    `/out:${outExe}`,
    '/utf8output',
    `/reference:${join(referenceDir, 'System.dll')}`,
    `/reference:${join(referenceDir, 'System.Core.dll')}`,
    `/reference:${join(referenceDir, 'System.Drawing.dll')}`,
    `/reference:${join(referenceDir, 'System.Windows.Forms.dll')}`,
    ...sources
  ];

  const result = spawnSync(csc, cscArgs, { stdio: 'inherit' });

  if (result.error) {
    console.error(`[sidecar] 启动编译器失败: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[sidecar] 编译失败，退出码 ${result.status}`);
    process.exit(result.status ?? 1);
  }

  const size = statSync(outExe).size;
  console.log(`[sidecar] 编译成功 -> ${outExe} (${(size / 1024).toFixed(0)} KB)`);
}

main();
