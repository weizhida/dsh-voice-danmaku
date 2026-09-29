/**
 * B 站弹幕接口的拒绝码 → 用户能照做的说明。
 *
 * 为什么它要独立成文件：**两条通道面对的是同一个服务端**。HTTP 直发拿到的
 * `code` 和页面注入（扩展从页面自己的请求里 hook 回来的）拿到的 `code`
 * 是同一套编号。分开写两份的话，某天补了一个码的解释，另一条通道就永远是
 * "服务端拒绝（-412）：服务端未说明原因"。
 */

/**
 * 常见拒绝码 → 说明。
 * 用 Map 而不是对象字面量：数字键在对象上是字符串化的，索引时容易写错类型。
 */
export const REJECTION_HINTS = new Map<number, string>([
  [-101, '账号未登录。登录态可能已过期，请刷新直播间页面重新登录。'],
  [-111, 'CSRF 校验失败。这通常意味着请求不是页面自己发出的 —— 请确认用的是页面注入通道。'],
  [-400, '请求参数有误。请检查直播间号是否正确。'],
  [-403, '被拒绝：可能在直播间被禁言，或账号权限不足。'],
  [-412, '被风控拦截。请降低发送频率，并确认弹幕内容合规。'],
  [-509, '触发了频率限制，请稍后再试。'],
  [10030, '直播间不存在或已关闭。'],
  [1003212, '弹幕内容被拒绝（可能是敏感词或重复内容）。']
]);

/**
 * 把拒绝码翻译成一句能照做的话。
 *
 * @param code - 服务端返回的 code。
 * @param serverMessage - 服务端给的原文，作为兜底。
 */
export function describeRejection(code: number, serverMessage: string): string {
  const hint = REJECTION_HINTS.get(code);
  if (hint !== undefined) return hint;
  if (serverMessage.trim().length > 0) return serverMessage;
  return '服务端未说明原因';
}
