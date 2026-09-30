#!/usr/bin/env node
/**
 * dsh-voice-danmaku —— sidecar 协议驱动器 / 冒烟测试
 * ============================================================================
 * 直接和 sidecar 的 exe 说话，不经 DSH。用途：
 *   * 开发时验证协议与 sidecar 行为，不用启动整个 DSH；
 *   * 排查"按了没反应"到底卡在哪一层；
 *   * CI 里跑一个不依赖 GUI 交互的协议自检。
 *
 * 用法：
 *   node tools/harness.mjs smoke                 启停 + ping + 配置回执（自动退出）
 *   node tools/harness.mjs show "一段测试文本"     显示浮层，等你按回车
 *   node tools/harness.mjs watch                  实时打印按键事件（按 Ctrl+C 退出）
 *   node tools/harness.mjs media [秒数]            实时打印媒体键事件（默认等 Ctrl+C）
 *   node tools/harness.mjs raw                    手工输入 JSON 行与 sidecar 对话
 *
 * 注意：按 F9/F10/F11 之类的热键只有你在真实窗口里按键才会产生事件，
 * 这个脚本没法伪造——它能验证的是协议、配置、浮层与诊断，不是游戏里的手感。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const exePath = join(root, 'sidecar', 'bin', 'dsh-voice-danmaku-sidecar.exe');

/** 默认热键：F9 录音/停止，F11 发送，F10 取消。 */
const DEFAULT_KEYS = [0x78, 0x79, 0x7a];

/** 冒烟用的媒体键：静音 / 播放暂停 / 下一曲。 */
const DEFAULT_MEDIA_KEYS = [0xad, 0xb3, 0xb0];

const command = process.argv[2] ?? 'smoke';
const argument = process.argv[3];

// 输出走 UTF-8：sidecar 的文本和日志里都有中文，不设这一项时
// Windows 控制台会按本地代码页解码，打印出来是乱码，会误导排查。
try {
  process.stdout.setDefaultEncoding?.('utf8');
} catch {
  /* 老版本 Node 不支持时忽略：只是打印问题，不影响测试结论 */
}

if (!existsSync(exePath)) {
  console.error(`[harness] 找不到 sidecar：${exePath}`);
  console.error('[harness] 先运行：node sidecar/build.mjs');
  process.exit(1);
}

/** 启动 sidecar，返回带收发能力的句柄。 */
function start() {
  // 把本进程 pid 交给 sidecar，让它能在我被强杀时自行退出，不留孤儿进程
  // 抓着全局热键不放。
  const child = spawn(exePath, ['--parent-pid', String(process.pid)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const listeners = new Set();

  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      console.log(`[sidecar:非JSON] ${trimmed}`);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  child.stderr.on('data', (chunk) => {
    console.log(`[sidecar:stderr] ${chunk.toString().trim()}`);
  });

  let exited = false;
  child.on('exit', (code, signal) => {
    exited = true;
    console.log(`[harness] sidecar 退出 code=${code} signal=${signal ?? 'none'}`);
  });

  return {
    child,
    get exited() {
      return exited;
    },
    send(message) {
      const line = JSON.stringify(message);
      console.log(`  -> ${line}`);
      child.stdin.write(`${line}\n`);
    },
    onMessage(listener) {
      listeners.add(listener);
    },
    /** 等待匹配的消息，超时抛错。 */
    waitFor(predicate, timeoutMs = 4000, label = '消息') {
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(handler);
          reject(new Error(`等待 ${label} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        const handler = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          listeners.delete(handler);
          resolvePromise(message);
        };
        listeners.add(handler);
      });
    },
    stop() {
      if (exited) return;
      try {
        child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
      } catch {
        /* 管道可能已经关了 */
      }
      setTimeout(() => {
        if (!exited) child.kill();
      }, 800);
    }
  };
}

/** 打印 sidecar 写的诊断日志尾部，帮我判断"按了没反应"卡在哪一层。 */
function printSidecarLogs() {
  const logDir = join(tmpdir(), 'dsh-voice-danmaku');
  if (!existsSync(logDir)) {
    console.log('[harness] 没有 sidecar 日志目录');
    return;
  }
  const files = readdirSync(logDir)
    .filter((name) => name.startsWith('sidecar-') && name.endsWith('.log'))
    .map((name) => ({ name, path: join(logDir, name) }));
  if (files.length === 0) {
    console.log('[harness] 没有 sidecar 日志文件');
    return;
  }
  // 取最近修改的那一份——多实例时它就是本次的。
  files.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  const latest = files[0];
  console.log(`\n[harness] sidecar 日志 (${latest.path}):`);
  const lines = readFileSync(latest.path, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(-40)) console.log(`  ${line}`);
}

/** 把 sidecar 的每条消息打印成人能读的形式。 */
function logMessage(message) {
  const { type, ...rest } = message;
  console.log(`  <- [${type}] ${JSON.stringify(rest)}`);
}

// ---------------------------------------------------------------------------
// smoke：不依赖人工操作的自检
// ---------------------------------------------------------------------------
async function smoke() {
  console.log('[harness] smoke：启动 sidecar 并跑一轮协议自检\n');
  const sidecar = start();
  sidecar.onMessage(logMessage);

  let failures = 0;
  const check = (ok, label, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  };

  try {
    const ready = await sidecar.waitFor((m) => m.type === 'ready', 6000, 'ready');
    check(ready.hookInstalled === true, '全局键盘钩子安装成功',
      ready.hookInstalled === false ? `Win32 错误码 ${ready.hookError}` : `pid=${ready.pid}`);
    check(ready.x64 === true, 'sidecar 以 64 位运行', `x64=${ready.x64}`);

    sidecar.send({
      type: 'configure',
      id: 'cfg-1',
      keys: DEFAULT_KEYS.join(','),
      consumeKeys: true,
      fontSize: 26,
      padding: 18,
      marginTop: 0,
      opacity: 88,
      anchorXPercent: 50,
      maxWidthPercent: 80,
      reassertSeconds: 2,
      clickThrough: true,
      draggable: true
    });
    const configured = await sidecar.waitFor((m) => m.type === 'configured', 3000, 'configured');
    check(configured.watched === DEFAULT_KEYS.join(','), '热键订阅生效', configured.labels);

    // 配置到底有没有真的送到原生层？只回 "configured" 不算证据 —— 字段可能
    // 在路上丢了。所以断言**实际生效的值**逐个对得上。
    const roundTrip = [
      ['fontSize', 26], ['padding', 18], ['marginTop', 0], ['opacity', 88]
    ];
    const mismatched = roundTrip.filter(([field, want]) => configured[field] !== want);
    check(mismatched.length === 0, '外观参数原样送达原生层',
      mismatched.length > 0
        ? mismatched.map(([f, want]) => `${f}: 期望 ${want} 实得 ${configured[f]}`).join('; ')
        : `fontSize=${configured.fontSize} padding=${configured.padding} opacity=${configured.opacity}`);
    check(configured.clickThrough === true && configured.draggable === true,
      '点击穿透与可拖动开关送达',
      `clickThrough=${configured.clickThrough} draggable=${configured.draggable}`);

    // 越界值必须被钳制而不是崩溃：设置界面写错一个数不该让浮层乱掉。
    sidecar.send({
      type: 'configure', id: 'cfg-clamp',
      keys: DEFAULT_KEYS.join(','), consumeKeys: true,
      fontSize: 5000, padding: 1, marginTop: -50, opacity: 5,
      anchorXPercent: 999, maxWidthPercent: 1,
      reassertSeconds: 2, clickThrough: false, draggable: false
    });
    const clamped = await sidecar.waitFor(
      (m) => m.type === 'configured' && m.id === 'cfg-clamp', 3000, 'configured(clamp)');
    check(clamped.fontSize === 96 && clamped.padding === 4 && clamped.marginTop === -50
      && clamped.opacity === 20,
      '越界参数被钳制到合法区间',
      `fontSize=${clamped.fontSize}(≤96) padding=${clamped.padding}(≥4) opacity=${clamped.opacity}(≥20)`);

    // 恢复成正常配置，后续浮层自检要用。
    sidecar.send({
      type: 'configure', id: 'cfg-2',
      keys: DEFAULT_KEYS.join(','), consumeKeys: true,
      fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
      anchorXPercent: 50, maxWidthPercent: 80, reassertSeconds: 2,
      clickThrough: true, draggable: true
    });
    await sidecar.waitFor((m) => m.type === 'configured' && m.id === 'cfg-2', 3000, 'configured(restore)');

    sidecar.send({ type: 'ping', id: 'ping-1' });
    await sidecar.waitFor((m) => m.type === 'pong', 3000, 'pong');
    check(true, 'ping/pong 往返正常');

    // ---- 媒体键 ----------------------------------------------------------
    // 媒体键走的是另一条通道（RegisterHotKey），这条断言验证的是"配置真的
    // 送进了那条通道"，而不是"按键能穿反作弊"——后者只能真机验证。
    sidecar.send({
      type: 'configure', id: 'cfg-media',
      keys: DEFAULT_KEYS.join(','), mediaKeys: DEFAULT_MEDIA_KEYS.join(','),
      consumeKeys: true, fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
      anchorXPercent: 50, maxWidthPercent: 80, reassertSeconds: 2,
      clickThrough: true, draggable: true
    });
    const media = await sidecar.waitFor(
      (m) => m.type === 'configured' && m.id === 'cfg-media', 3000, 'configured(media)');
    check(media.mediaKeys === DEFAULT_MEDIA_KEYS.join(','), '媒体键订阅生效', media.mediaKeys);
    // 只断言回执的**形状**，不断言"三个都注册成功"：媒体键是共享资源，注册失败
    // 是合法结果（别的程序占着），而那正是这个回执要说明的事。
    check(/^ok=/.test(String(media.mediaKeysReport ?? '')), '媒体键注册回执可解析',
      String(media.mediaKeysReport ?? ''));

    // 关掉开关必须立刻把键还给别的程序，不能等重启。
    sidecar.send({
      type: 'configure', id: 'cfg-media-off',
      keys: DEFAULT_KEYS.join(','), mediaKeys: '',
      consumeKeys: true, fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
      anchorXPercent: 50, maxWidthPercent: 80, reassertSeconds: 2,
      clickThrough: true, draggable: true
    });
    const mediaOff = await sidecar.waitFor(
      (m) => m.type === 'configured' && m.id === 'cfg-media-off', 3000, 'configured(media-off)');
    check(mediaOff.mediaKeys === '' && mediaOff.mediaKeysReport === 'ok=',
      '停用后媒体键被注销（键立刻还给别的程序）',
      `mediaKeys="${mediaOff.mediaKeys}" report="${mediaOff.mediaKeysReport}"`);

    // 浮层：显示、自检"是否真的在最顶层且没抢焦点"、再隐藏。
    sidecar.send({
      type: 'show', id: 'show-1', state: 'confirm',
      text: '这是一条用于自检的示例弹幕文本，用来确认浮层排版正常。',
      accent: '#3B82F6',
      hint: 'F11 发送 · F10 取消 · F9 重说',
      showHint: true
    });
    const shown = await sidecar.waitFor((m) => m.type === 'shown', 4000, 'shown');
    check(typeof shown.overlayHwnd === 'number' && shown.overlayHwnd !== 0, '浮层窗口已创建');
    check(shown.topMost === 1, '浮层为置顶窗口');
    check(shown.focusKept === true, '浮层显示未抢走前台焦点',
      `before=${shown.foregroundBefore} after=${shown.foregroundAfter}`);
    check(shown.rect !== '0,0,0,0', '浮层有非零尺寸', `rect=${shown.rect}`);

    sidecar.send({ type: 'verify', id: 'verify-1' });
    const verification = await sidecar.waitFor((m) => m.type === 'verification', 3000, 'verification');
    check(verification.visible === true, '浮层处于可见状态');
    // 开了点击穿透时 WindowFromPoint 会跳过浮层，那种情况下"中心点不是自己"
    // 是预期行为，不能算被遮挡。
    check(
      verification.selfAtCenter === true || verification.occluded === 'skipped-transparent',
      '浮层中心点没有被其他置顶窗口遮挡',
      `selfAtCenter=${verification.selfAtCenter} occluded=${verification.occluded}`
    );
    check(verification.withinScreen === true, '浮层完全落在显示器范围内', `screen=${verification.screen}`);

    sidecar.send({ type: 'hide', id: 'hide-1' });
    await sidecar.waitFor((m) => m.type === 'state', 3000, 'state');
    check(true, '隐藏浮层正常');

    sidecar.send({ type: 'shutdown' });
    await new Promise((r) => setTimeout(r, 900));
    check(sidecar.exited, '收到 shutdown 后进程正常退出（无孤儿进程）');
  } catch (error) {
    failures++;
    console.error(`\n[harness] 自检中断：${error.message}`);
  } finally {
    sidecar.stop();
  }

  printSidecarLogs();

  console.log(failures === 0
    ? '\n[harness] smoke 全部通过。\n' +
      '  热键链路已由 npm run test:hotkey 单独验证；\n' +
      '  剩下需要真人的是"你的游戏是否放行钩子"：npm run verify:hotkey'
    : `\n[harness] smoke 有 ${failures} 项失败，见上。`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// show：显示一段文本并停留，让人肉眼看浮层
// ---------------------------------------------------------------------------
async function show() {
  const text = argument ?? '浮层测试：请确认这段字压在你的游戏窗口上方，且游戏仍然能操作。';
  console.log('[harness] 显示浮层，按回车隐藏并退出\n');
  const sidecar = start();
  sidecar.onMessage(logMessage);

  await sidecar.waitFor((m) => m.type === 'ready', 6000, 'ready');
  sidecar.send({
    type: 'configure', id: 'cfg', keys: DEFAULT_KEYS.join(','), consumeKeys: true,
    fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
    anchorXPercent: 50, maxWidthPercent: 80, reassertSeconds: 2
  });
  await sidecar.waitFor((m) => m.type === 'configured', 3000, 'configured');

  sidecar.send({
    type: 'show', id: 'show', state: 'confirm', text,
    accent: '#3B82F6', hint: 'F11 发送 · F10 取消 · F9 重说', showHint: true
  });
  await sidecar.waitFor((m) => m.type === 'shown', 4000, 'shown');

  sidecar.send({ type: 'verify', id: 'v' });
  const verification = await sidecar.waitFor((m) => m.type === 'verification', 3000, 'verification');
  console.log(`\n[harness] 诊断：onTop=${verification.onTopAtCenter} 前景窗口=${verification.foreground}`);
  console.log('[harness] 现在切到游戏窗口看看浮层是否还在最上面。看完回来按回车。\n');

  await new Promise((resolvePromise) => {
    process.stdin.once('data', resolvePromise);
  });
  sidecar.stop();
  printSidecarLogs();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// watch：实时打印按键事件（验证热键是否被捕获）
// ---------------------------------------------------------------------------
async function watch() {
  console.log('[harness] 监听按键事件。现在去按 F9 / F10 / F11（在任意窗口，包括游戏里）。Ctrl+C 退出。\n');
  const sidecar = start();

  // 把每条按键事件同时写进记录文件：这样"游戏里到底收到没收到"变成一份
  // 可以事后翻阅的证据，而不是靠人回忆或截图。
  const reportPath = join(root, '.verify', `hotkey-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = openSync(reportPath, 'a');
  const seen = new Map();

  sidecar.onMessage((message) => {
    if (message.type !== 'key') {
      logMessage(message);
      return;
    }
    const stamp = new Date().toLocaleTimeString();
    console.log(`  ${stamp}  ${message.phase.toUpperCase().padEnd(4)} ${message.key.padEnd(12)} 前景窗口: ${message.foreground}`);
    const counters = seen.get(message.key) ?? { down: 0, up: 0 };
    counters[message.phase === 'down' ? 'down' : 'up'] += 1;
    seen.set(message.key, counters);
    writeSync(report, `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`);
  });

  await sidecar.waitFor((m) => m.type === 'ready', 6000, 'ready');
  sidecar.send({
    type: 'configure', id: 'cfg', keys: DEFAULT_KEYS.join(','), consumeKeys: true,
    fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
    anchorXPercent: 50, maxWidthPercent: 80, reassertSeconds: 2
  });
  await sidecar.waitFor((m) => m.type === 'configured', 3000, 'configured');
  console.log('[harness] 已订阅热键，等待按键……\n');

  const finish = () => {
    closeSync(report);
    console.log(`\n[harness] 按键统计：${seen.size === 0 ? '（一个都没收到）' : ''}`);
    for (const [key, counters] of [...seen.entries()].sort()) {
      console.log(`  ${key.padEnd(6)} 按下 ${counters.down} 次，抬起 ${counters.up} 次`);
    }
    console.log(`[harness] 记录文件：${reportPath}`);
    sidecar.stop();
    setTimeout(() => {
      printSidecarLogs();
      process.exit(seen.size === 0 ? 1 : 0);
    }, 900);
  };

  process.on('SIGINT', finish);
  // Windows 上 Ctrl+C 在管道场景里不一定触发 SIGINT，兜住 readline 关闭。
  process.stdin.on('close', finish);
}

// ---------------------------------------------------------------------------
// inject：自动化验证热键链路（不需要人工按键）
// ---------------------------------------------------------------------------
/**
 * 合成按键，验证"钩子 → 协议 → 分发"这条链路。
 *
 * **它不能替代真机验证。** 合成输入绕过硬件与游戏输入栈，因此测不出
 * "某游戏用内核级输入/反作弊挡住钩子"。它证明的是：钩子装上了、订阅生效了、
 * 键码解析对了、事件能穿过管道到达主程序。
 *
 * 哪一层坏了能从结果直接看出来：
 *   * 一个键都没收到 → 钩子没捕获（或钩子被系统摘掉了）；
 *   * 收到别的键码   → 订阅或键码映射错了；
 *   * 只收到一半     → 唤醒/投递时序问题。
 */
async function inject() {
  console.log('[harness] 自动化热键链路验证（合成按键）\n');
  const sidecar = start();

  const received = [];
  sidecar.onMessage((message) => {
    if (message.type === 'key') {
      received.push(message);
      console.log(`  <- ${message.phase.toUpperCase().padEnd(4)} ${message.key.padEnd(6)} vk=${message.vk}  前台: ${message.foreground}`);
    } else {
      logMessage(message);
    }
  });

  await sidecar.waitFor((m) => m.type === 'ready', 6000, 'ready');
  sidecar.send({
    type: 'configure', id: 'cfg', keys: DEFAULT_KEYS.join(','), consumeKeys: true,
    fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
    anchorXPercent: 50, maxWidthPercent: 80, reassertSeconds: 2
  });
  await sidecar.waitFor((m) => m.type === 'configured', 3000, 'configured');

  const injector = join(here, 'inject-key.ps1');
  if (!existsSync(injector)) {
    console.error(`[harness] 找不到注入器 ${injector}`);
    sidecar.stop();
    process.exit(1);
  }

  // 逐个注入，每个之间留出足够时间让事件穿过管道。
  for (const code of DEFAULT_KEYS) {
    console.log(`  -> 注入 vk=${code} (${KEY_NAMES[code] ?? '?'})`);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', injector, '-Code', String(code)
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      console.log(`     注入器返回码 ${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  await new Promise((r) => setTimeout(r, 800));

  let failures = 0;
  console.log('');
  for (const code of DEFAULT_KEYS) {
    const name = KEY_NAMES[code] ?? String(code);
    const downs = received.filter((m) => m.vk === code && m.phase === 'down');
    const ups = received.filter((m) => m.vk === code && m.phase === 'up');
    const ok = downs.length === 1 && ups.length === 1;
    if (!ok) failures += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${name} 按下 ${downs.length} 次 / 抬起 ${ups.length} 次`);
  }

  sidecar.stop();
  await new Promise((r) => setTimeout(r, 900));
  printSidecarLogs();

  console.log(failures === 0
    ? '\n[harness] 热键链路（钩子→协议→分发）验证通过。'
    : `\n[harness] 有 ${failures} 个键没有被正确捕获，见上。`);
  process.exit(failures === 0 ? 0 : 1);
}

/** 虚拟键码 → 名字，只用于打印。 */
const KEY_NAMES = { 0x77: 'F8', 0x78: 'F9', 0x79: 'F10', 0x7a: 'F11' };

// ---------------------------------------------------------------------------
// media：验证媒体键通道（这条命令回答"我该把哪个键填进配置"）
// ---------------------------------------------------------------------------
/**
 * 注册**所有**常见的媒体键，然后实时打印收到的按键。
 *
 * 为什么需要它：媒体键那条通道（`RegisterHotKey`）与键盘钩子是两回事，
 * `verify:hotkey` 完全测不到它。而这里有两个各自独立、都可能失败的问题：
 *
 *   1. **注册失败** —— 键被别的程序占了（会打印在下面）；
 *   2. **按下去根本没事件** —— 键被耳机/键鼠厂商的驱动软件吃掉了，
 *      `RegisterHotKey` 注册得上但收不到。
 *
 * 后者只能靠"按下并观察"发现。跑完这一条，你就知道该往配置里填哪三个键名了。
 */
async function media() {
  console.log('[harness] 媒体键验证。分两步做，对比结果：');
  console.log('  第一步：现在（桌面）依次按你准备用作 录音/发送/取消 的三个媒体键，记下键名；');
  console.log('  第二步：**切进游戏再按一遍**。这一步才回答"游戏里能不能用"。');
  console.log('[harness] 注意：测试期间音量键会被本进程接管，音量调节可能不生效。Ctrl+C 退出。\n');

  const sidecar = start();
  const counts = new Map();
  /**
   * 握过手了没有。
   *
   * 退出处理必须在 await 之前注册（管道 stdin 可能在握手完成前就 close，
   * 那时再注册就永远收不到了，表现为脚本挂死）。但没握手就退出时不能打印
   * "一个键都没收到"——那句话会被当成结论，而实际上根本没开始监听。
   */
  let armed = false;
  /** 防止"定时器到点"与 Ctrl+C 同时触发，导致摘要打印两遍。 */
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (!armed) {
      sidecar.stop();
      setTimeout(() => process.exit(1), 900);
      return;
    }
    console.log('\n[harness] 收到的媒体键：');
    if (counts.size === 0) {
      console.log('  （一个都没收到）');
      console.log('[harness] 结论：系统没有把这些键交给我们。常见原因：');
      console.log('  · 键盘/耳机厂商的驱动软件先一步吃掉了它们（试试关掉那个软件）；');
      console.log('  · 键不在候选列表里（那就直接手填键码，见 src/keys.ts 的表）。');
    } else {
      for (const [name, n] of [...counts.entries()].sort()) {
        console.log(`  ${name.padEnd(20)} 按下 ${n} 次`);
      }
      console.log('\n[harness] 把上面这些名字填进设置的「媒体键」那一组即可。');
    }
    sidecar.stop();
    setTimeout(() => {
      printSidecarLogs();
      process.exit(counts.size === 0 ? 1 : 0);
    }, 900);
  };

  process.on('SIGINT', finish);
  process.stdin.on('close', finish);

  sidecar.onMessage((message) => {
    if (message.type !== 'key') {
      logMessage(message);
      return;
    }
    const stamp = new Date().toLocaleTimeString();
    const name = String(message.key ?? '?');
    console.log(`  ${stamp}  ${String(message.phase).toUpperCase().padEnd(4)} ` +
      `${name.padEnd(20)} vk=0x${Number(message.vk).toString(16).toUpperCase().padEnd(3)} ` +
      `来源=${message.source}  前台: ${message.foreground}`);
    if (message.phase === 'down') counts.set(name, (counts.get(name) ?? 0) + 1);
  });

  await sidecar.waitFor((m) => m.type === 'ready', 6000, 'ready');
  // 注册全部候选：用户还没配过，所以这里不能只订阅"已配置的键"。
  sidecar.send({
    type: 'configure', id: 'cfg', keys: '', consumeKeys: false,
    mediaKeys: MEDIA_KEY_CANDIDATES.join(','),
    fontSize: 26, padding: 18, marginTop: 0, opacity: 88,
    anchorXPercent: 50, maxWidthPercent: 80, reassertSeconds: 2
  });
  const configured = await sidecar.waitFor((m) => m.type === 'configured', 3000, 'configured');
  armed = true;
  console.log(`\n[harness] 注册结果：${configured.mediaKeysReport}\n`);
  console.log('[harness] 已订阅下列媒体键，等待按键……\n  ' +
    MEDIA_KEY_NAMES.join('、') + '\n');

  // 可选的自动结束。给一个上限是有实际必要的：这些媒体键会一直被本进程占着，
  // 而"忘了关掉的终端"是个很常见的结局。
  const seconds = Number(argument ?? 0);
  if (Number.isFinite(seconds) && seconds > 0) {
    console.log(`[harness] ${seconds} 秒后自动结束（加 `+'`0`'+` 表示一直等到 Ctrl+C）。\n`);
    setTimeout(finish, seconds * 1000);
  }
}

/** 全部媒体键候选。探测阶段要广撒网：用户还没配过，不能只订阅"已配置的键"。 */
const MEDIA_KEY_CANDIDATES = [
  0xad, 0xae, 0xaf,                   // 静音 / 音量减 / 音量加
  0xb0, 0xb1, 0xb2, 0xb3,             // 下一曲 / 上一曲 / 停止 / 播放暂停
  0xb4, 0xb5,                         // 邮件 / 媒体选择
  0xac,                               // 浏览器主页（部分键盘把它当媒体键用）
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab  // 浏览器后退/前进/刷新/停止/搜索/收藏
];

/** 候选键的名字，只为打印（与 sidecar 的 KeyNames 一致）。 */
const MEDIA_KEY_NAMES = [
  'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp',
  'MediaTrackNext', 'MediaTrackPrevious', 'MediaStop', 'MediaPlayPause',
  'LaunchMail', 'LaunchMediaSelect',
  'BrowserHome', 'BrowserBack', 'BrowserForward', 'BrowserRefresh',
  'BrowserStop', 'BrowserSearch', 'BrowserFavorites'
];

// ---------------------------------------------------------------------------
// raw：手工对话
// ---------------------------------------------------------------------------
async function raw() {
  console.log('[harness] 手工模式：输入 JSON 行发给 sidecar。Ctrl+C 退出。\n');
  const sidecar = start();
  sidecar.onMessage(logMessage);
  await sidecar.waitFor((m) => m.type === 'ready', 6000, 'ready');

  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed) sidecar.send(JSON.parse(trimmed));
  });
}

const modes = { smoke, show, watch, raw, inject, media };
const runner = modes[command];
if (!runner) {
  console.error(`[harness] 未知模式: ${command}（可用: ${Object.keys(modes).join(', ')}）`);
  process.exit(1);
}
await runner();
