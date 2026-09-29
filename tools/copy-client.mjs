#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 把浏览器半区复制进构建产物
 * ============================================================================
 * `src/client/index.js` 是**手写的**客户端 bundle（格式是 DSH 运行时模块加载器
 * 要求的 `window.__ModuleLoader__.load({id, factory})`），不是 TypeScript 产物，
 * 所以 `tsc` 不管它，需要单独拷进 `lib/`。
 *
 * 为什么不把它写成 TypeScript 再编译：客户端 bundle 的形态由加载器规定，
 * 手写能一眼看清它到底往页面里注册了什么；而且这样引入零构建依赖
 * （官方包用 tsdown，我们不引入）。详见 src/client/index.js 顶部说明。
 *
 * 用法：node tools/copy-client.mjs
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = join(root, 'src', 'client', 'index.js');
const targetDir = join(root, 'lib', 'client');
const target = join(targetDir, 'index.js');

if (!existsSync(source)) {
  console.error(`[client] 找不到浏览器半区源码：${source}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);

// package.json 的 exports 把 ./client 指向 lib/client.js，而 lib/client.js
// 是 tsc 无法产出的东西，所以这里也从同一份源码拷一份过去 —— 让导出路径与
// DSH 期望的入口完全对齐，不依赖加载器去猜目录索引。
copyFileSync(source, join(root, 'lib', 'client.js'));

console.log(`[client] 已复制浏览器半区 -> lib/client/index.js 与 lib/client.js`);
