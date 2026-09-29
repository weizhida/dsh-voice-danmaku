/**
 * ffmpeg 探测的单元测试。
 *
 * 这个模块存在的理由是"别让用户手填一个他不可能知道的路径"。而它最容易出错的
 * 恰恰是**找不到时**的分支 —— 那正是用户第一次使用时会遇到的情况，也恰恰是
 * 开发机上（装了 ffmpeg）永远测不到的情况。所以这里用注入的假文件系统把
 * 两种情形都覆盖掉。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ffmpegCandidates, ffmpegMissingMessage, resolveFfmpeg } from '../lib/ffmpeg.js';

/** 构造一个"只有这些路径存在"的假环境。 */
function fakeDeps(existing, env) {
  const checked = [];
  return {
    deps: {
      exists(path) {
        checked.push(path);
        return existing.includes(path);
      },
      env
    },
    checked
  };
}

const BASE_ENV = {
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  ProgramFiles: 'C:\\Program Files',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\u',
  PATH: 'C:\\Windows;C:\\tools'
};

describe('ffmpeg 探测 —— 候选位置', () => {
  it('把显式配置放在第一位（用户指定优先于一切猜测）', () => {
    const candidates = ffmpegCandidates('D:\\my\\ffmpeg.exe', fakeDeps([], BASE_ENV).deps);
    assert.equal(candidates[0], 'D:\\my\\ffmpeg.exe');
  });

  it('展开 PATH 里的每一个目录', () => {
    const candidates = ffmpegCandidates('', fakeDeps([], BASE_ENV).deps);
    assert.ok(candidates.includes('C:\\Windows\\ffmpeg.exe'), '应包含 PATH 第一项');
    assert.ok(candidates.includes('C:\\tools\\ffmpeg.exe'), '应包含 PATH 第二项');
  });

  it('包含包管理器的安装位置', () => {
    const candidates = ffmpegCandidates('', fakeDeps([], BASE_ENV).deps);
    const joined = candidates.join('\n');
    assert.match(joined, /WinGet[\\/]Links[\\/]ffmpeg\.exe/, '缺少 winget 位置');
    assert.match(joined, /scoop[\\/]shims[\\/]ffmpeg\.exe/, '缺少 scoop 位置');
    assert.match(joined, /chocolatey[\\/]bin[\\/]ffmpeg\.exe/, '缺少 choco 位置');
  });

  it('候选不重复（PATH 与兜底列表可能指向同一处）', () => {
    const candidates = ffmpegCandidates('C:\\tools\\ffmpeg.exe', fakeDeps([], BASE_ENV).deps);
    assert.equal(new Set(candidates).size, candidates.length);
  });

  it('环境变量缺失时不会崩（不假设变量一定存在）', () => {
    const candidates = ffmpegCandidates('', fakeDeps([], {}).deps);
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.includes('C:\\ffmpeg\\bin\\ffmpeg.exe'), '应保留硬编码兜底');
  });
});

describe('ffmpeg 探测 —— 解析结果', () => {
  it('找到时返回该路径', () => {
    const target = 'C:\\tools\\ffmpeg.exe';
    const { deps } = fakeDeps([target], BASE_ENV);
    const result = resolveFfmpeg('', deps);
    assert.equal(result.path, target);
  });

  it('显式配置命中时优先采用它', () => {
    const explicit = 'D:\\my\\ffmpeg.exe';
    const { deps } = fakeDeps([explicit, 'C:\\tools\\ffmpeg.exe'], BASE_ENV);
    assert.equal(resolveFfmpeg(explicit, deps).path, explicit);
  });

  it('找不到时返回 undefined，并**记录下来探测过哪些位置**', () => {
    const { deps, checked } = fakeDeps([], BASE_ENV);
    const result = resolveFfmpeg('', deps);

    assert.equal(result.path, undefined);
    // 这条断言是这个模块的核心价值：失败时必须能告诉用户"我找过哪儿"，
    // 否则他只会看到"没有找到 ffmpeg"而不知道下一步该干什么。
    assert.ok(result.checked.length > 0, '必须记录探测过的位置');
    assert.ok(checked.length > 0);
  });

  it('裸命令名不做存在性检查（它要靠 PATH 解析，不是文件路径）', () => {
    const existsCalls = [];
    const deps = {
      exists(p) {
        existsCalls.push(p);
        return false;
      },
      env: BASE_ENV
    };
    resolveFfmpeg('ffmpeg', deps);
    assert.ok(!existsCalls.includes('ffmpeg'), '裸命令名不该被当成路径去检查');
  });
});

describe('ffmpeg 探测 —— 缺失时的提示', () => {
  it('提示里包含可直接执行的安装命令', () => {
    const message = ffmpegMissingMessage(['C:\\a\\ffmpeg.exe', 'C:\\b\\ffmpeg.exe']);
    assert.match(message, /winget install/, '应给出 winget 命令');
    assert.match(message, /scoop install/, '应给出 scoop 命令');
    assert.match(message, /choco install/, '应给出 choco 命令');
  });

  it('提示里说明探测过的位置数量，避免用户以为我们没找', () => {
    const message = ffmpegMissingMessage(['A', 'B', 'C', 'D', 'E']);
    assert.match(message, /5 处/);
  });

  it('提示里给出"手动指定路径"这条出路', () => {
    const message = ffmpegMissingMessage(['A']);
    assert.match(message, /设置/, '应指向设置项');
  });
});
