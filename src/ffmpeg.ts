/**
 * 查找 ffmpeg 可执行文件。
 *
 * ## 为什么要这么一个模块
 *
 * 第一版把 `ffmpeg` 做成一个纯文本设置项，等于要求用户"凭空写出 ffmpeg 的
 * 安装路径"。这是个糟糕的设计：绝大多数人不知道它装在哪，而且这个值在每台
 * 机器上都不同 —— 让用户填等于把环境探测的活儿推给了人。
 *
 * 正确做法是插件自己去常见的几个地方找，只在实在找不到时才要求人工指定。
 * 本模块把"去哪儿找、按什么顺序找"这件事收敛到一处，并做成可注入依赖的纯逻辑，
 * 这样"找不到时的行为"也能被测试覆盖，而不是只能靠一台没装 ffmpeg 的机器来撞。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 依赖注入点：便于测试"找不到"的分支。 */
export interface FfmpegResolverDeps {
  /** 检查一个路径是否存在。 */
  exists(path: string): boolean;
  /** 环境变量。 */
  env: Record<string, string | undefined>;
}

/** 默认依赖：真实文件系统与进程环境。 */
export const realDeps: FfmpegResolverDeps = {
  exists: (path) => existsSync(path),
  env: process.env
};

/**
 * 候选位置，按优先级排列。
 *
 * 顺序是有讲究的：显式配置 > PATH > 包管理器（winget/scoop/choco）> 手工解压的
 * 常见目录。包管理器排在前面的原因是它们装了之后通常**会**进 PATH，
 * 这些固定路径只是兜底（比如 winget 的 Links 目录在某些配置下不在 PATH 里）。
 *
 * @param configured - 用户显式配置的值；空串表示没配。
 * @param deps - 注入的探测能力。
 * @returns 去重后的候选绝对路径列表。
 */
export function ffmpegCandidates(
  configured: string,
  deps: FfmpegResolverDeps = realDeps
): string[] {
  const env = deps.env;
  const local = env.LOCALAPPDATA ?? '';
  const roaming = env.APPDATA ?? '';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programData = env.ProgramData ?? 'C:\\ProgramData';
  const home = env.USERPROFILE ?? '';

  const list: string[] = [];

  // 1. 显式配置。带路径分隔符的当路径用；否则当命令名（交给 PATH 解析）。
  const trimmed = configured.trim();
  if (trimmed.length > 0) list.push(trimmed);

  // 2. PATH 里的 ffmpeg（最常见的情况：装完就能用）
  const pathEntries = (env.PATH ?? '').split(';').filter((p) => p.trim().length > 0);
  for (const dir of pathEntries) {
    list.push(join(dir, 'ffmpeg.exe'));
  }

  // 3. 包管理器的固定安装位置
  if (local.length > 0) {
    list.push(join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    list.push(join(local, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'));
  }
  if (home.length > 0) list.push(join(home, 'scoop', 'shims', 'ffmpeg.exe'));
  list.push(join(programData, 'chocolatey', 'bin', 'ffmpeg.exe'));

  // 4. 手工解压的常见位置
  list.push(join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'));
  list.push('C:\\ffmpeg\\bin\\ffmpeg.exe');

  // 5. 附带的相对位置（有人会把 ffmpeg 放在 DSH 目录旁边）
  if (roaming.length > 0) list.push(join(roaming, 'ffmpeg', 'bin', 'ffmpeg.exe'));

  // 去重但保序：同一个目录被 PATH 和兜底列表同时命中时不要重复探测。
  return [...new Set(list.map((p) => p.trim()).filter((p) => p.length > 0))];
}

/** 解析结果。 */
export interface FfmpegResolution {
  /** 可用的 ffmpeg 路径；找不到时为 undefined。 */
  path: string | undefined;
  /** 实际探测过的候选位置（找不到时用来告诉用户"我找过哪儿"）。 */
  checked: string[];
}

/**
 * 解析出一个可用的 ffmpeg 路径。
 *
 * 注意"可执行文件存在"只是必要条件：我们不能在这里真的运行它（那会在设置读取
 * 路径上引入子进程开销）。真正的可用性由录音前的 probe 确认。
 */
export function resolveFfmpeg(
  configured: string,
  deps: FfmpegResolverDeps = realDeps
): FfmpegResolution {
  const candidates = ffmpegCandidates(configured, deps);
  const checked: string[] = [];

  for (const candidate of candidates) {
    // 只有像路径的候选才做存在性检查；裸命令名（如 `ffmpeg`）留给 PATH 解析，
    // 在上面已经展开成 PATH 里的绝对路径了。
    if (!candidate.includes('\\') && !candidate.includes('/')) continue;
    checked.push(candidate);
    if (deps.exists(candidate)) return { path: candidate, checked };
  }

  return { path: undefined, checked };
}

/** 没找到 ffmpeg 时给用户看的说明。 */
export function ffmpegMissingMessage(checked: string[]): string {
  const sample = checked.slice(0, 3).join('\n  ');
  return [
    '没有找到 ffmpeg，而它是录音必需的（Node 本身没有麦克风采集能力）。',
    '',
    '安装方式（任选一种）：',
    '  winget install Gyan.FFmpeg        # 推荐，装完自动进 PATH',
    '  scoop install ffmpeg',
    '  choco install ffmpeg',
    '',
    '或者从 ffmpeg.org 下载后解压，在设置里把「ffmpeg 位置」填成它的完整路径。',
    '',
    `我已经找过这些位置（共 ${checked.length} 处）：`,
    `  ${sample}`,
    checked.length > 3 ? '  …' : ''
  ].filter((line) => line !== '').join('\n');
}
