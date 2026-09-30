/**
 * 统一日志出口。
 *
 * 为什么不直接用 `console`：DSH 宿主的 stdout 承载着别的东西，插件在里面乱写
 * 会污染宿主输出。这里统一加 `[voice-danmaku]` 前缀并走 `console.error`
 * （stderr 是安全的诊断通道），方便在 DSH 日志里一眼捞出来。
 *
 * ## 为什么还要再写一份到文件
 *
 * 因为看不着。DSH 桌面版不把宿主 stderr 落盘，出问题时插件的一切输出都随风而逝 ——
 * 排查"点了启动没反应"那次，我三次卡在"没有任何插件日志可看"上，只能靠推断。
 * 所以除了 stderr，这里再追加写一份到固定文件。
 *
 * 位置：`~/.dsh/logs/dsh-voice-danmaku.log`（超过 1MB 轮转一份 `.1`）。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PREFIX = '[voice-danmaku]';

const LOG_DIR = join(homedir(), '.dsh', 'logs');
const LOG_FILE = join(LOG_DIR, 'dsh-voice-danmaku.log');
/** 超过这个大小就轮转一份 `.1`，避免无限增长。 */
const MAX_BYTES = 1024 * 1024;

/** 目录是否已经确认可用（省掉每次都 mkdir）。 */
let fileReady = false;

/** 写一条信息级日志。 */
export function log(message: string, ...details: unknown[]): void {
  write('info', message, details);
}

/** 写一条警告。用于"能继续跑但用户应该知道"的情况，例如配置缺失。 */
export function warn(message: string, ...details: unknown[]): void {
  write('warn', message, details);
}

/** 写一条错误。 */
export function error(message: string, ...details: unknown[]): void {
  write('error', message, details);
}

function write(level: 'info' | 'warn' | 'error', message: string, details: unknown[]): void {
  const body = details.length > 0
    ? `${message} ${details.map(describe).join(' ')}`
    : message;
  const labeled = level === 'info' ? body : `[${level}] ${body}`;
  // 全部走 stderr：这是插件唯一可以安全使用的诊断通道。
  console.error(`${PREFIX} ${labeled}`);

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
  writeToFile(`${stamp} ${labeled}`);
}

/**
 * 追加一行到日志文件。
 *
 * 刻意吞掉一切异常（目录不可写、磁盘满、被占用）：日志本身不该成为新的故障源。
 * 这里也不再调用 warn/error —— 那会无限递归。
 */
function writeToFile(line: string): void {
  try {
    if (!fileReady) {
      mkdirSync(LOG_DIR, { recursive: true });
      fileReady = true;
    }
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // 忽略。
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
