#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— 识别链路端到端自测
 * ============================================================================
 * 不走插件、不进游戏，直接验证"麦克风 → 录音 → 识别"这一段是否可用。
 *
 * 为什么需要它：插件内部的这段链路上游还有热键和浮层，一旦出问题很难判断是哪
 * 一层。这个脚本把中间层剥掉，只留录音与识别，输出也全是它自己的，不受插件
 * 日志干扰。
 *
 * 它做的事：
 *   1. 从 `~/.dsh/settings.yaml` 读你的 voice-danmaku 配置（密钥、语言等）；
 *   2. 自动探测 ffmpeg、自动选麦克风；
 *   3. 录一段指定秒数的音频，把音量（峰值/均值）报出来；
 *   4. 调用识别服务，打印识别结果与耗时。
 *
 * 音量那一项是刻意加的：如果识别结果不对，第一件要知道的事是"到底有没有录到
 * 声音"。有波形但识别错 = 识别问题；几乎没波形 = 麦克风/增益问题。
 *
 * 用法：
 *   node tools/test-asr.mjs            录 4 秒
 *   node tools/test-asr.mjs --seconds 6
 *   node tools/test-asr.mjs --device "麦克风 (NVIDIA Broadcast)"
 *   node tools/test-asr.mjs --list     只列出设备和配置，不录音
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createRecorder, enumerateAudioDevices } from '../lib/audio.js';
import { createAsrEngine } from '../lib/asr/registry.js';
import { Config } from '../lib/config.js';
import { resolveFfmpeg } from '../lib/ffmpeg.js';

// --- 参数 -------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const seconds = Number(flag('--seconds', '4'));
const deviceArg = flag('--device', '');
const listOnly = args.includes('--list');

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

// --- 读设置 -----------------------------------------------------------------
// 我们自己解析这一小段 YAML：只取 voice-danmaku 段里的几个标量，
// 为此引一个 YAML 库不划算。
function readSettings() {
  const path = join(homedir(), '.dsh', 'settings.yaml');
  if (!existsSync(path)) {
    fail(`找不到设置文件 ${path}\n  先在 DSH 里 设置 → 语音弹幕 配置一次，或直接编辑这个文件。`);
  }

  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const section = {};
  const stack = [{ indent: -1, node: section }];
  let inVoice = false;

  for (const line of lines) {
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
    if (match === null) continue;

    // 顶层键：只在 voice-danmaku 段内收集
    if (indent === 0) {
      inVoice = match[1] === 'voice-danmaku';
      continue;
    }
    if (!inVoice) continue;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (match[2].length === 0) {
      parent[match[1]] = {};
      stack.push({ indent, node: parent[match[1]] });
    } else {
      parent[match[1]] = coerce(match[2]);
    }
  }
  return section;
}

/**
 * 把 YAML 标量转成对应的 JS 类型。
 *
 * 不做这一步会踩坑：schema 收到字符串 "true" 会抛
 * `expected boolean but got true` —— 错误信息看起来像类型对，实际是字符串。
 */
function coerce(raw) {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  // 纯数字才转；保留 "0755" 这类带前导零的字符串，避免被当数字。
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

const stored = readSettings();
const config = new Config(stored);

console.log('== 配置 ==');
console.log('  识别地址 :', config.asr.baseUrl);
console.log('  模型     :', config.asr.model);
console.log('  语言     :', config.asr.language);
console.log('  API 密钥 :', config.asr.apiKey.length > 0 ? `已设置（${config.asr.apiKey.length} 字符）` : '**未设置**');
console.log('  ffmpeg   :', config.audio.ffmpegPath.trim().length > 0 ? config.audio.ffmpegPath : '（自动探测）');
console.log('  设备配置 :', config.audio.device.trim().length > 0 ? config.audio.device : '（自动选第一个）');

if (config.asr.apiKey.length === 0) {
  fail('没有 API 密钥。\n  去 DSH 设置 → 语音弹幕 → 识别服务 → API 密钥，粘贴后**点保存**。\n  注意：该字段出于安全考虑永远显示为空，但保存时必须填值，留空等于清空。');
}

// --- ffmpeg 与设备 ----------------------------------------------------------
const resolution = resolveFfmpeg(config.audio.ffmpegPath);
if (resolution.path === undefined) {
  fail(`找不到 ffmpeg。已探测 ${resolution.checked.length} 处。\n  安装：winget install Gyan.FFmpeg`);
}
console.log('\n== ffmpeg ==');
console.log('  ', resolution.path);

console.log('\n== 录音设备 ==');
const { devices, raw } = await enumerateAudioDevices(resolution.path);
if (devices.length === 0) {
  fail(
    '没有找到可用的麦克风。\n' +
    '  请确认麦克风已插好，且「设置 → 系统 → 声音 → 输入」里能看到它。\n' +
    (raw.trim().length > 0 ? `  ffmpeg 输出末尾：\n${raw.trim().slice(-300)}` : '')
  );
}
devices.forEach((d, i) => console.log(`  ${i === 0 ? '→' : ' '} ${d}`));

const device = deviceArg.trim().length > 0 ? deviceArg : (config.audio.device.trim() || devices[0]);
if (deviceArg.trim().length > 0 && !devices.includes(deviceArg)) {
  console.log(`\n⚠ 你指定的设备名不在列表里，仍然尝试使用：「${deviceArg}」`);
}
console.log(`\n  将使用：「${device}」`);

if (listOnly) {
  console.log('\n（--list 模式，未录音）');
  process.exit(0);
}

// --- 录音 -------------------------------------------------------------------
console.log(`\n== 录音 ${seconds} 秒 ==`);
console.log('  >>> 现在开始说话 <<<');

const recorder = createRecorder({ ffmpegPath: resolution.path, deviceName: device });
recorder.start();
await new Promise((r) => setTimeout(r, seconds * 1000));

const stopAt = Date.now();
let wav;
try {
  wav = await recorder.stop();
} catch (cause) {
  fail(`录音失败：${cause instanceof Error ? cause.message : String(cause)}`);
}
console.log(`  停止耗时 ${Date.now() - stopAt} ms`);
console.log(`  音频 ${(wav.length / 1024).toFixed(1)} KB（16kHz 单声道）`);

// 音量统计：判断"识别不准"到底是识别问题还是没录到声音。
const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, Math.floor((wav.length - 44) / 2));
let peak = 0;
let sum = 0;
for (const s of samples) {
  const a = Math.abs(s);
  if (a > peak) peak = a;
  sum += a;
}
const mean = samples.length > 0 ? sum / samples.length : 0;
const peakPercent = ((peak / 32768) * 100).toFixed(1);
console.log(`  峰值 ${peak}（满量程的 ${peakPercent}%）  均值 ${mean.toFixed(0)}`);

if (peak < 100) {
  console.log('  ⚠ 几乎没录到声音 —— 检查麦克风是否静音、是否选错设备、或系统未授权麦克风。');
} else if (peak < 1000) {
  console.log('  ⚠ 音量偏低 —— 可以在「声音设置 → 输入 → 音量」里调高增益。');
} else {
  console.log('  ✓ 音量正常');
}

// --- 识别 -------------------------------------------------------------------
console.log('\n== 识别 ==');
const engine = createAsrEngine(config);
const started = Date.now();
try {
  const text = await engine.transcribe({
    audio: wav,
    language: config.asr.language,
    timeoutMs: config.asr.timeoutMs
  });
  console.log(`  耗时 ${Date.now() - started} ms`);
  console.log(`  结果：「${text.trim()}」`);
  if (text.trim().length === 0) {
    console.log('  ⚠ 返回空字符串 —— 可能是没识别到内容，或服务端认为音频无效。');
  }
} catch (cause) {
  fail(`识别失败：${cause instanceof Error ? cause.message : String(cause)}`);
}
