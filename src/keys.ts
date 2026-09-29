/**
 * 虚拟键码（Virtual-Key Code）工具。
 *
 * 为什么用数字键码而不是 "F9" 这种字符串当内部表示：
 * 键码是 Windows 那边唯一稳定的标识；"F9" 只是给人看的。
 * sidecar 只认数字，配置里允许写名字只是为了让人好改。
 */

/** 常用按键名 → 虚拟键码。只收录有用的键，避免抄一整张表进来。 */
const NAME_TO_CODE: Readonly<Record<string, number>> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Pause: 0x13,
  CapsLock: 0x14,
  Esc: 0x1b,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  Num0: 0x60,
  Num1: 0x61,
  Num2: 0x62,
  Num3: 0x63,
  Num4: 0x64,
  Num5: 0x65,
  Num6: 0x66,
  Num7: 0x67,
  Num8: 0x68,
  Num9: 0x69,
  NumMultiply: 0x6a,
  NumAdd: 0x6b,
  NumSubtract: 0x6d,
  NumDecimal: 0x6e,
  NumDivide: 0x6f,
  LShift: 0xa0,
  RShift: 0xa1,
  LCtrl: 0xa2,
  RCtrl: 0xa3,
  LAlt: 0xa4,
  RAlt: 0xa5,

  // 媒体键与浏览器键。**名字刻意与 Chrome 的 `KeyboardEvent.key` 保持一致**：
  // 设置页的「按一下媒体键」按钮就是把 event.key 原样写进配置的，两边同名
  // 才能让捕获结果直接被这里解析，不需要维护一张对照表。
  //
  // 为什么这些键值得单独列出来：它们是唯一能绕过游戏反作弊的通道（普通键盘
  // 钩子在 ACE/TP 面前完全瞎掉，而 HID Consumer Control 走的是另一条上报路径）。
  BrowserBack: 0xa6,
  BrowserForward: 0xa7,
  BrowserRefresh: 0xa8,
  BrowserStop: 0xa9,
  BrowserSearch: 0xaa,
  BrowserFavorites: 0xab,
  BrowserHome: 0xac,
  AudioVolumeMute: 0xad,
  VolumeMute: 0xad,
  AudioVolumeDown: 0xae,
  VolumeDown: 0xae,
  AudioVolumeUp: 0xaf,
  VolumeUp: 0xaf,
  MediaTrackNext: 0xb0,
  MediaNextTrack: 0xb0,
  MediaTrackPrevious: 0xb1,
  MediaPreviousTrack: 0xb1,
  MediaStop: 0xb2,
  MediaPlayPause: 0xb3,
  LaunchMail: 0xb4,
  LaunchMediaSelect: 0xb5
};

/**
 * 媒体键候选键码。
 *
 * 用途是**捕获**：设置页的捕获按钮只监听浏览器事件，而这里的列表给的是
 * "合理取值区间"。之所以要它，是因为浏览器对**被驱动或厂商软件吃掉**的
 * 媒体键可能什么都不报；那时用户只能手填。列表越完整，需要手填的情况越少。
 */
export const MEDIA_KEY_CODES: readonly number[] = [
  0xad, 0xae, 0xaf, // 静音 / 音量减 / 音量加
  0xb0, 0xb1, 0xb2, 0xb3, // 下一曲 / 上一曲 / 停止 / 播放暂停
  0xb5 // 媒体选择
];

/** 补齐单字母 / 数字 / F1..F24。 */
for (let i = 0; i < 24; i += 1) {
  (NAME_TO_CODE as Record<string, number>)[`F${i + 1}`] = 0x70 + i;
}
for (let i = 0; i < 10; i += 1) {
  (NAME_TO_CODE as Record<string, number>)[String(i)] = 0x30 + i;
}
for (let i = 0; i < 26; i += 1) {
  const letter = String.fromCharCode(0x41 + i);
  (NAME_TO_CODE as Record<string, number>)[letter] = 0x41 + i;
}

const CODE_TO_NAME: Readonly<Record<number, string>> = (() => {
  const result: Record<number, string> = {};
  for (const [name, code] of Object.entries(NAME_TO_CODE)) {
    // 同义名（如 Esc/Escape）只保留先出现的那个，保证键名稳定可预测。
    if (result[code] === undefined) result[code] = name;
  }
  return result;
})();

/**
 * 把配置里的按键写法解析成虚拟键码。
 * 接受 `F9`、`PageUp`、`MediaPlayPause` 这类名字，也接受 `179`、`0xB3` 这类数字。
 *
 * ## 名字优先于纯数字（一个真实的坑）
 *
 * `0`–`9` 既是"数字键的名字"又是"十进制键码"，两者冲突。原来数字优先，
 * 结果是 `parseKey('0')` 得到键码 **0**、而 `describeKey(0x30)` 得到 `'0'` ——
 * 同一个字符串指向两个不同的键，往返不闭合（这一条被 test/keys.test.mjs 的
 * 往返不变量抓出来）。
 *
 * 现在名字优先。理由：键码 0–9 是**鼠标键**（`VK_LBUTTON` 等），对键盘热键
 * 没有任何意义，而"数字键 0"是一个用户真会配的东西。多位数字仍按键码解释，
 * 所以 `48` 和 `0` 都指向数字键 0，两种写法都对。
 *
 * @returns 键码；无法识别时返回 undefined（由调用方决定是报错还是忽略）。
 */
export function parseKey(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;

  if (/^0x[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed, 16);

  // 名字大小写不敏感，F9 与 f9 等价。
  const direct = NAME_TO_CODE[trimmed];
  if (direct !== undefined) return direct;
  const canonical = Object.keys(NAME_TO_CODE).find(
    (name) => name.toLowerCase() === trimmed.toLowerCase()
  );
  if (canonical !== undefined) return NAME_TO_CODE[canonical];

  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return undefined;
}

/** 把虚拟键码还原成可读名；未知键回退为 `VK_0x78` 形式。 */
export function describeKey(code: number): string {
  return CODE_TO_NAME[code] ?? `VK_0x${code.toString(16).toUpperCase()}`;
}
