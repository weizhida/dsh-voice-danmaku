/**
 * 录音设备枚举的单元测试。
 *
 * 这个解析器修的是一个**真机测试暴露的必然失败**：第一版把录音命令写成
 * `-i audio=default`，而 dshow 不接受 `default` 这个名字，必须用确切设备名。
 * 也就是说"能不能录音"完全取决于这个解析器对不对。
 *
 * ffmpeg 的设备清单输出格式是固定的（写到 stderr），所以用真实格式的样本
 * 就能完整覆盖。样本包含现实里会遇到的几种情况：视频设备混在一起、
 * 设备名带空格、Alternative name 行、以及典型的本地化设备名。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAudioDeviceNames } from '../lib/audio.js';

/** 一段贴近真实的 ffmpeg 设备枚举输出（含视频设备与 Alternative name）。 */
const REAL_SHAPE = [
  "[dshow @ 000001] \"Camera (NVIDIA Broadcast)\" (video)",
  "[dshow @ 000001]   Alternative name \"@device_sw_{860BB310-...}\\{7BBFF097-...}\"",
  "[dshow @ 000001] \"OBS Virtual Camera\" (none)",
  "[dshow @ 000001]   Alternative name \"@device_sw_{860BB310-...}\\{A3FCE0F5-...}\"",
  "[dshow @ 000001] \"麦克风 (USB Audio Device)\" (audio)",
  "[dshow @ 000001]   Alternative name \"@device_cm_{33D9A762-...}\\wave_{...}\"",
  "[dshow @ 000001] \"耳机式麦克风 (Realtek Audio)\" (audio)",
  "[dshow @ 000001]   Alternative name \"@device_cm_{33D9A762-...}\\wave_{...}\"",
  "Could not enumerate audio only devices (or none found)."
].join('\n');

describe('录音设备枚举 —— 解析 ffmpeg 输出', () => {
  it('只取 (audio) 设备，忽略视频设备', () => {
    const devices = parseAudioDeviceNames(REAL_SHAPE);
    assert.deepEqual(devices, ['麦克风 (USB Audio Device)', '耳机式麦克风 (Realtek Audio)']);
  });

  it('不把 (video) 或 (none) 当成音频设备', () => {
    const devices = parseAudioDeviceNames(REAL_SHAPE);
    assert.ok(!devices.some((d) => d.includes('NVIDIA Broadcast')), '混入了视频设备');
    assert.ok(!devices.some((d) => d.includes('OBS Virtual Camera')), '混入了虚拟摄像头');
  });

  it('不把 Alternative name 当成设备名', () => {
    const devices = parseAudioDeviceNames(REAL_SHAPE);
    assert.ok(!devices.some((d) => d.includes('@device_')), '混入了 Alternative name');
  });

  it('保留设备名里的空格与括号（必须与系统里逐字一致）', () => {
    const devices = parseAudioDeviceNames(REAL_SHAPE);
    assert.equal(devices[0], '麦克风 (USB Audio Device)');
  });

  it('保持 ffmpeg 给出的顺序（第一个就是我们要默认用的）', () => {
    const devices = parseAudioDeviceNames(REAL_SHAPE);
    assert.equal(devices[0], '麦克风 (USB Audio Device)');
  });

  it('没有音频设备时返回空数组，而不是抛错', () => {
    const output = [
      "[dshow @ 1] \"Camera\" (video)",
      "Could not enumerate audio only devices (or none found)."
    ].join('\n');
    assert.deepEqual(parseAudioDeviceNames(output), []);
  });

  it('空输出返回空数组', () => {
    assert.deepEqual(parseAudioDeviceNames(''), []);
  });

  it('同名设备只保留一个（避免重复枚举）', () => {
    const output = [
      "[dshow @ 1] \"麦克风\" (audio)",
      "[dshow @ 1] \"麦克风\" (audio)"
    ].join('\n');
    assert.deepEqual(parseAudioDeviceNames(output), ['麦克风']);
  });

  it('处理 CRLF 换行（Windows 上 ffmpeg 可能这样输出）', () => {
    const output = "[dshow @ 1] \"麦克风\" (audio)\r\n[dshow @ 1] \"Camera\" (video)\r\n";
    assert.deepEqual(parseAudioDeviceNames(output), ['麦克风']);
  });

  it('纯英文设备名也能解析（英文系统）', () => {
    const output = '[dshow @ 1] "Microphone (Realtek(R) Audio)" (audio)';
    assert.deepEqual(parseAudioDeviceNames(output), ['Microphone (Realtek(R) Audio)']);
  });
});

describe('录音设备枚举 —— 与 ffmpeg 的约定', () => {
  it('解析出的名字可以直接拼进 -i audio=<名字>', () => {
    const [first] = parseAudioDeviceNames(REAL_SHAPE);
    // 这是最关键的一致性：解析出来的东西必须就是 -i 参数里能用的东西。
    assert.equal(`audio=${first}`, 'audio=麦克风 (USB Audio Device)');
  });
});
