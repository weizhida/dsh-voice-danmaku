/**
 * 统一日志出口。
 *
 * 为什么不直接用 `console`：DSH 宿主的 stdout 承载着别的东西，插件在里面乱写
 * 会污染宿主输出。这里统一加 `[voice-danmaku]` 前缀并走 `console.error`
 * （stderr 是安全的诊断通道），方便在 DSH 日志里一眼捞出来。
 */

const PREFIX = '[voice-danmaku]';

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
  const line = details.length > 0
    ? `${PREFIX} ${message} ${details.map(describe).join(' ')}`
    : `${PREFIX} ${message}`;
  // 全部走 stderr：这是插件唯一可以安全使用的诊断通道。
  console.error(line);
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
