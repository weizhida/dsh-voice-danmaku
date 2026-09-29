/**
 * 弹幕文本的清洗与校验。
 *
 * 两个通道（HTTP 直发、页面注入）必须用**同一套**规则：一条被清洗过的文本
 * 没道理因为换了发送方式就变得合法或非法。所以它从 `bilibili.ts` 里搬了出来。
 */


/**
 * 清洗文本。
 *
 * 弹幕是单行内容：换行和制表符会破坏表单编码，也会在直播间里显示成乱码。
 * 顺带压掉连续空白 —— 语音识别的结果经常带多余空格。
 */
export function sanitizeDanmaku(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 校验清洗后的文本能否作为一条弹幕。
 *
 * **只检查空**。长度不在这里管：状态机会按设置（`channel.maxLength`）在显示之前
 * 截断，而最终能不能发出去由 B 站裁决 —— 通道再拦一次只会制造
 * "状态机说能发、通道说不发"这种自相矛盾，用户看到的则是一条莫名其妙的失败。
 *
 * @returns 不可以时的原因；可以时返回 undefined。
 */
export function validateDanmaku(message: string): string | undefined {
  if (message.length === 0) return '内容为空';
  return undefined;
}
