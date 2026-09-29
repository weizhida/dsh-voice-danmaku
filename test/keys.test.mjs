/**
 * 虚拟键码工具的单元测试。
 *
 * 这个模块小，但它错一次代价很大：配置里的键名解析不出来 = **热键整条失效**，
 * 而且用户看到的是"按了没反应"，不会想到是名字对不上。媒体键尤其如此 ——
 * 那些键名（`MediaPlayPause` 之类）是设置页的捕获按钮**直接写进配置**的，
 * 一旦两边的名字对不上，捕获到的值就成了一个永远解析不出的字符串。
 *
 * 所以这里除了逐个断言，还钉住一条不变量：**键码 → 名字 → 键码** 必须回到原值。
 * 改名字、加同义名时它会被立刻抓出来。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MEDIA_KEY_CODES, describeKey, parseKey } from '../lib/keys.js';

describe('parseKey', () => {
  it('认识普通按键名', () => {
    assert.equal(parseKey('F9'), 0x78);
    assert.equal(parseKey('PageUp'), 0x21);
    assert.equal(parseKey('Num0'), 0x60);
  });

  it('认识媒体键名（与浏览器的 KeyboardEvent.key 同名）', () => {
    assert.equal(parseKey('AudioVolumeMute'), 0xad);
    assert.equal(parseKey('MediaPlayPause'), 0xb3);
    assert.equal(parseKey('MediaTrackNext'), 0xb0);
    assert.equal(parseKey('MediaTrackPrevious'), 0xb1);
    assert.equal(parseKey('AudioVolumeUp'), 0xaf);
  });

  it('名字大小写不敏感', () => {
    assert.equal(parseKey('mediaplaypause'), 0xb3);
    assert.equal(parseKey('AUDIOVOLUMEMUTE'), 0xad);
  });

  it('接受十进制与十六进制键码', () => {
    assert.equal(parseKey('179'), 179);
    assert.equal(parseKey('0xB3'), 0xb3);
    assert.equal(parseKey('0x78'), 0x78);
  });

  it('单个数字按"数字键"解释，多位数字才当键码', () => {
    // 0–9 既是数字键的名字又是十进制键码，两者冲突。名字优先：键码 0–9 是
    // 鼠标键，对键盘热键没有意义；而数字键是人真会配的东西。
    assert.equal(parseKey('0'), 0x30);
    assert.equal(parseKey('5'), 0x35);
    // 多位数字仍按键码解释，所以两种写法都指向数字键 0。
    assert.equal(parseKey('48'), 0x30);
  });

  it('两侧空白被忽略（配置文件里手改时常见）', () => {
    assert.equal(parseKey('  F9  '), 0x78);
  });

  it('无法识别时返回 undefined，而不是抛错或猜一个', () => {
    assert.equal(parseKey('不存在的键'), undefined);
    assert.equal(parseKey(''), undefined);
    assert.equal(parseKey('   '), undefined);
    assert.equal(parseKey('MediaPlayPausee'), undefined);
  });
});

describe('describeKey', () => {
  it('把键码还原成名字', () => {
    assert.equal(describeKey(0x78), 'F9');
    assert.equal(describeKey(0xad), 'AudioVolumeMute');
    assert.equal(describeKey(0xb3), 'MediaPlayPause');
  });

  it('未知键回退成 VK_0x 形式，而不是空串', () => {
    // 空串会让日志里出现"热键 （前台：…）"这种没法排查的行。
    assert.equal(describeKey(0xff), 'VK_0xFF');
  });
});

describe('键码 → 名字 → 键码 的往返', () => {
  it('媒体键候选全部可往返', () => {
    for (const code of MEDIA_KEY_CODES) {
      const name = describeKey(code);
      assert.notEqual(name, `VK_0x${code.toString(16).toUpperCase()}`, `0x${code.toString(16)} 没有名字`);
      assert.equal(parseKey(name), code, `describeKey(${code}) = ${name} 解析不回原值`);
    }
  });

  it('普通按键也全部可往返（改名字会打断已有配置）', () => {
    const codes = [
      0x08, 0x09, 0x0d, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
      0x2c, 0x2d, 0x2e, 0x60, 0x61, 0x6a, 0x70, 0x87, 0xa0, 0xa2, 0xa4,
      0x41, 0x5a, 0x30, 0x39
    ];
    for (const code of codes) {
      const name = describeKey(code);
      assert.equal(parseKey(name), code, `describeKey(${code}) = ${name} 解析不回原值`);
    }
  });

  it('媒体键候选互不重复（重复会让一个键绑两个动作）', () => {
    assert.equal(new Set(MEDIA_KEY_CODES).size, MEDIA_KEY_CODES.length);
  });
});
