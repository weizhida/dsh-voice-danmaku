/**
 * 定位 sidecar 可执行文件，必要时现场编译。
 *
 * exe 不进版本库（`sidecar/bin/` 在 .gitignore 里，且 npm 包也不含它）——
 * 二进制入库会带来体积、审计和"源码与产物不一致"三类问题。
 * 代价是需要一个首次运行的编译步骤，这里把它自动化掉。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, warn } from './logger.js';

/** Build 输出路径，相对于包根。 */
const EXE_RELATIVE_PATH = join('sidecar', 'bin', 'dsh-voice-danmaku-sidecar.exe');
const BUILD_SCRIPT_RELATIVE_PATH = join('sidecar', 'build.mjs');

/**
 * 包根目录。
 * 编译产物布局是 `lib/sidecar-path.js` → 包根在上一级；
 * 源码布局是 `src/sidecar-path.ts` → 同样在上一级。
 * 两种布局的父目录数恰好相同，所以一个 `..` 就够。
 */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** exe 的绝对路径（不论它是否存在）。 */
export function sidecarExePath(): string {
  return join(packageRoot(), EXE_RELATIVE_PATH);
}

/** 环境变量覆盖：给"我自己编译了别处的 exe"和排查问题留的口子。 */
function overridePath(): string | undefined {
  const raw = process.env.DSH_VOICE_DANMAKU_SIDECAR;
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * 确保 sidecar 可用，返回它的绝对路径。
 *
 * 顺序：环境变量覆盖 → 已编译的 exe → 现场调用 build.mjs 编译。
 * 编译失败时抛错，并把编译器的 stderr 带出来——这是最常见的首次运行故障，
 * 错误信息必须足够让人自己修好。
 */
export async function ensureSidecar(): Promise<string> {
  const override = overridePath();
  if (override !== undefined) {
    if (!existsSync(override)) {
      throw new Error(`DSH_VOICE_DANMAKU_SIDECAR 指向的文件不存在: ${override}`);
    }
    return override;
  }

  const exe = sidecarExePath();
  if (existsSync(exe)) return exe;

  const root = packageRoot();
  const buildScript = join(root, BUILD_SCRIPT_RELATIVE_PATH);
  if (!existsSync(buildScript)) {
    throw new Error(
      `sidecar 未编译且找不到构建脚本（期望 ${buildScript}）。` +
      '如果你是从 npm 安装的，请在包目录里运行 `node sidecar/build.mjs`。'
    );
  }

  warn('sidecar 尚未编译，正在尝试现场编译（仅首次需要）');
  mkdirSync(dirname(exe), { recursive: true });
  const output = await runBuild(buildScript, root);

  if (!existsSync(exe)) {
    throw new Error(`sidecar 编译后仍未找到产物 ${exe}。编译器输出：\n${output}`);
  }
  log('sidecar 编译完成');
  return exe;
}

/** 执行 build.mjs 并收集输出。 */
function runBuild(script: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      // 编译器的诊断信息在 stderr 上，两条都要收。
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let collected = '';
    const append = (chunk: Buffer): void => {
      collected += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    child.on('error', (cause) => {
      reject(new Error(`无法启动 sidecar 构建脚本: ${cause.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(collected);
        return;
      }
      reject(new Error(
        `sidecar 编译失败（退出码 ${code}）。\n` +
        '常见原因：找不到 C# 编译器。Windows 通常自带于\n' +
        '  C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe\n' +
        `编译器输出：\n${collected}`
      ));
    });
  });
}
