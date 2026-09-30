/**
 * 状态机与限流的单元测试。
 *
 * 这两块是"错了会真的害到用户"的地方：
 *   * 状态机错了 = 弹幕在错误的时机发出去，或者按键失灵；
 *   * 限流错了 = 插件可能变成刷屏机，代价是账号风控。
 *
 * 它们都是纯逻辑，所以用**注入的假依赖**就能完整覆盖，不需要麦克风、
 * 不需要网络、不需要 Windows。
 *
 * 被测的是 `lib/` 下的编译产物：接口与运行时代码完全一致，而且不需要
 * 额外的类型剥离步骤（Node 22 默认不剥离 TS 类型）。
 *
 * 运行：npm test（或 node --test test/）
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { VoiceDanmakuMachine } from '../lib/machine.js';
import { describeKey, parseKey } from '../lib/keys.js';

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

/** 记录所有对外交互，供断言检查。 */
function createHarness(options = {}) {
  const record = {
    overlayCalls: [],
    sounds: [],
    notifications: [],
    sent: [],
    transcribed: 0
  };

  // 每次录音"产出"的音频与转写结果都由这里驱动，方便构造各种场景。
  const state = {
    audio: new Uint8Array([1, 2, 3]),
    transcript: '今晚这波打得不错',
    sendError: undefined,
    transcribeError: undefined,
    startError: undefined
  };

  const deps = {
    async startRecording() {
      if (state.startError !== undefined) throw state.startError;
    },
    async stopRecording() {
      return state.audio;
    },
    async transcribe() {
      record.transcribed += 1;
      if (state.transcribeError !== undefined) throw state.transcribeError;
      return state.transcript;
    },
    async send(text) {
      record.sent.push(text);
      // 卡住发送，用来观察"发送过程中"的状态（那期间按键应当无效）。
      if (state.sendHold !== undefined) await state.sendHold;
      if (state.sendError !== undefined) throw state.sendError;
      // 模拟"结果未知"：请求可能已经出去了，但没拿到确认。
      if (state.sendUnsure === true) {
        return { unsure: true, reason: state.sendUnsureReason ?? '没抓到服务端的回执' };
      }
    },
    overlay(view) {
      record.overlayCalls.push(view);
    },
    sound(kind) {
      record.sounds.push(kind);
    },
    notify(message, level) {
      record.notifications.push({ message, level });
    }
  };

  const machineOptions = {
    soundFeedback: true,
    autoSend: false,
    maxLength: 20,
    confirmTimeoutSeconds: 0,
    ...options
  };

  const machine = new VoiceDanmakuMachine(deps, () => machineOptions);
  return { machine, record, state, machineOptions };
}

/** 把机器推进到"等待确认"状态，并返回它。 */
async function advanceToConfirm(harness, transcript) {
  if (transcript !== undefined) harness.state.transcript = transcript;
  await harness.machine.handleKey('record');   // 开始录
  await harness.machine.handleKey('record');   // 停止并转写
  return harness;
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

describe('状态机 —— 正常路径', () => {
  it('空闲时按录音键进入录音状态，并显示"正在听"', async () => {
    const harness = createHarness();
    await harness.machine.handleKey('record');

    assert.equal(harness.machine.state, 'recording');
    const last = harness.record.overlayCalls.at(-1);
    assert.match(last.text, /正在听/);
    assert.deepEqual(harness.record.sounds, ['start']);
  });

  it('再按一次结束录音，转写后进入确认状态', async () => {
    const harness = await advanceToConfirm(createHarness());

    assert.equal(harness.machine.state, 'confirm');
    assert.equal(harness.machine.pending, '今晚这波打得不错');
    assert.equal(harness.record.transcribed, 1);
    // 音效顺序必须是"开始 → 停止 → 待确认"，这是给盲操作的人的反馈。
    assert.deepEqual(harness.record.sounds, ['start', 'stop', 'confirm']);
  });

  it('确认状态下按发送键把文本交给通道，然后回到空闲', async () => {
    const harness = await advanceToConfirm(createHarness());
    await harness.machine.handleKey('send');

    assert.deepEqual(harness.record.sent, ['今晚这波打得不错']);
    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.machine.pending, '');
    // 浮层这时显示的是一个短暂的"已发送"提示（1.2 秒后自动收起），
    // 而不是立刻消失——发完给个确认对盲操作很重要。
    const toast = harness.record.overlayCalls.at(-1);
    assert.match(toast.text, /已发送/);
  });

  it('成功提示会在短暂停留后自动收起浮层', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const harness = await advanceToConfirm(createHarness());
    await harness.machine.handleKey('send');
    assert.match(harness.record.overlayCalls.at(-1).text, /已发送/);

    t.mock.timers.tick(2000);

    assert.equal(harness.record.overlayCalls.at(-1), null, '提示必须自动消失，不能一直挂在游戏画面上');
    t.mock.timers.reset();
  });

  it('确认状态下再按录音键 = 重说，重新开始录音', async () => {
    const harness = await advanceToConfirm(createHarness());
    await harness.machine.handleKey('record');

    assert.equal(harness.machine.state, 'recording');
    assert.equal(harness.machine.pending, '');
  });

  it('发送失败时回到空闲并给出失败反馈，不会卡在发送中', async () => {
    const harness = await advanceToConfirm(createHarness());
    harness.state.sendError = new Error('服务端拒绝（-412）');
    await harness.machine.handleKey('send');

    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.machine.pending, '');
    const failureNotice = harness.record.notifications.at(-1);
    assert.equal(failureNotice.level, 'error');
    assert.match(failureNotice.message, /-412/);
  });
});

describe('状态机 —— 发送结果未知', () => {
  /**
   * 这一组的判据来自一条设计上的批评，值得原样记下来：
   *
   * > "任何不确定状态下告诉用户不确定，请用户自己检查，就不要有重发功能。
   * >  我说的锁定是发送过程中锁定。超时或者没收到回执就告诉用户自行检查，
   * >  也不会有按键解锁什么的"
   *
   * 所以这里要同时钉住三件事：
   *   1. **发送过程中**才是锁定（那期间按键无效）；
   *   2. 结果未知时**如实说"不知道"**，既不报失败也不报成功；
   *   3. **没有"重发"这条路** —— 文本丢弃，也没有任何按键解锁机制。
   */

  /** 把机器推到"发送结果未知"。 */
  async function advanceToUnsure() {
    const harness = await advanceToConfirm(createHarness());
    harness.state.sendUnsure = true;
    await harness.machine.handleKey('send');
    return harness;
  }

  it('结果未知时如实说"不知道"，并且正常回到空闲（不锁死）', async () => {
    const harness = await advanceToUnsure();

    assert.equal(harness.machine.state, 'idle', '不卡在某个特殊状态里');
    const view = harness.record.overlayCalls.at(-1);
    assert.match(view.text, /结果未知/);
    assert.doesNotMatch(view.text, /失败/, '不能写成"失败"——那是在诱导用户重试');
    assert.match(view.hint, /确认/, '要指向"自己去查"');
  });

  it('提示等级是 warn 而不是 error（error 读作"出错了，再试一次"）', async () => {
    const harness = await advanceToUnsure();
    const notice = harness.record.notifications.at(-1);

    assert.equal(notice.level, 'warn');
    assert.match(notice.message, /自行|确认/);
  });

  it('文案里不出现任何诱导重试的词', async () => {
    const harness = await advanceToUnsure();
    const texts = [
      harness.record.notifications.at(-1).message,
      ...harness.record.overlayCalls.filter(Boolean).map((v) => `${v.text} ${v.hint}`)
    ].join(' ');

    assert.doesNotMatch(texts, /重试|重发|再试|再来一次/,
      '一旦暗示"可以再试"，用户就会重说一遍 —— 而这条可能已经发出去了');
  });

  it('没有"重发上一条"这条路：文本被丢弃', async () => {
    const harness = await advanceToUnsure();

    assert.equal(harness.machine.pending, '',
      '待确认文本必须清空 —— 项目里不该存在"重发上一条"这个动作');
  });

  it('结果未知之后按发送键什么都不会发生（没有待发内容）', async () => {
    const harness = await advanceToUnsure();
    const sentBefore = harness.record.sent.length;

    await harness.machine.handleKey('send');

    assert.equal(harness.record.sent.length, sentBefore, '不会凭空重发一条');
    assert.equal(harness.machine.state, 'idle');
  });

  it('发送过程中（sending）按键被忽略 —— 这才是"锁定"的含义', async () => {
    const harness = await advanceToConfirm(createHarness());

    // 让 send 挂住，好让机器停在 sending 状态上。
    let release;
    harness.state.sendHold = new Promise((resolve) => { release = resolve; });

    const sending = harness.machine.handleKey('send');
    await Promise.resolve();
    assert.equal(harness.machine.state, 'sending');

    // 发送期间按录音键：不该开始录音，也不该重复发送。
    const sentBefore = harness.record.sent.length;
    await harness.machine.handleKey('record');
    assert.equal(harness.machine.state, 'sending', '发送过程中不接受输入');
    assert.equal(harness.record.sent.length, sentBefore, '不会重复发送');

    release();
    await sending;
    assert.equal(harness.machine.state, 'idle');
  });
});

describe('状态机 —— 失败必须让用户看得见', () => {
  /**
   * 这一组来自一个真实的问题："语音输入欠费了，你做没做错误的提示？"
   *
   * 查下来两个洞：
   *   1. **识别失败只写了日志**，浮层直接消失 —— 用户看到的是"说完话什么都没发生"，
   *      他无从知道是余额不足、密钥失效还是网络不通；
   *   2. **空结果也只有日志** —— 而"经常说完都不识别"正是撞在这里。
   *
   * 日志对用户等于不存在：他不会去看。**任何失败都必须在浮层上说一句。**
   */

  it('识别失败时把原因放到浮层上，而不是只写日志', async () => {
    const harness = createHarness();
    harness.state.transcribeError = new Error(
      '转写服务账户余额不足（HTTP 403）：余额不足，请充值'
    );

    await harness.machine.handleKey('record');
    await harness.machine.handleKey('record');

    const view = harness.record.overlayCalls.at(-1);
    assert.ok(view !== null && view !== undefined,
      '浮层上必须有东西 —— 只写日志等于用户什么都看不到');
    assert.match(view.text, /识别失败/);
    assert.match(view.hint, /余额/, '欠费的原因要原样带出来，用户才知道该去充值');
  });

  it('识别到空结果时也要有提示（这多半就是"说完不识别"的现场）', async () => {
    const harness = await advanceToConfirm(createHarness(), '   ');

    const view = harness.record.overlayCalls.at(-1);
    assert.ok(view !== null && view !== undefined, '空结果不能静默处理');
    assert.match(view.text, /没有听到声音/);
    assert.match(view.hint, /再试一次/);
  });

  it('错误提示停留得比成功提示久（1.2 秒在游戏里读不完一句话）', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const harness = createHarness();
    harness.state.transcribeError = new Error('识别服务出错');

    await harness.machine.handleKey('record');
    await harness.machine.handleKey('record');

    // 走过成功提示的时长（1.2 秒）：错误提示**必须还在**。
    t.mock.timers.tick(1300);
    assert.notEqual(harness.record.overlayCalls.at(-1), null,
      '1.3 秒后错误提示就消失的话，用户的眼神还没来得及从游戏移过来');

    // 走过错误提示的时长（4.5 秒）：这时才自动隐藏（不能永远挡着）。
    t.mock.timers.tick(3400);
    assert.equal(harness.record.overlayCalls.at(-1), null, '读完就该收起来');

    t.mock.timers.reset();
  });
});

describe('状态机 —— 句末标点', () => {
  /**
   * 直播间弹幕的习惯是不写句末标点。所以识别完**在显示之前**就去掉 ——
   * 用户看到的必须就是将要发出去的东西，不能等他确认之后再偷偷改。
   */

  it('句末的标点被去掉', async () => {
    const harness = await advanceToConfirm(createHarness(), '今天天气不错。');
    assert.equal(harness.machine.pending, '今天天气不错');
  });

  it('连着好几个标点一起去掉', async () => {
    const harness = await advanceToConfirm(createHarness(), '真的吗？！');
    assert.equal(harness.machine.pending, '真的吗');
  });

  it('英文标点和省略号同样处理', async () => {
    assert.equal((await advanceToConfirm(createHarness(), 'hello!')).machine.pending, 'hello');
    assert.equal((await advanceToConfirm(createHarness(), '让我想想…')).machine.pending, '让我想想');
  });

  it('只动末尾：句子中间的标点原样保留', async () => {
    const harness = await advanceToConfirm(createHarness(), '你好，今天天气不错。');
    assert.equal(harness.machine.pending, '你好，今天天气不错');
  });

  it('不碰成对的括号和引号（删一半比留着更难看）', async () => {
    const harness = await advanceToConfirm(createHarness(), '好耶（笑）');
    assert.equal(harness.machine.pending, '好耶（笑）');
  });

  it('整句只有标点时按"没听到声音"处理，不弹空确认框', async () => {
    const harness = await advanceToConfirm(createHarness(), '。。。');

    assert.equal(harness.machine.state, 'idle', '不该弹出一个空的确认框');
    assert.match(String(harness.record.overlayCalls.at(-1)?.text), /没有听到声音/);
  });
});

describe('状态机 —— 边界与拒绝', () => {
  it('空闲时按发送键是空操作（游戏里误按不该有任何后果）', async () => {
    const harness = createHarness();
    await harness.machine.handleKey('send');

    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.record.sent.length, 0);
    assert.equal(harness.record.overlayCalls.length, 0);
  });

  it('识别结果为空时给出提示，但不弹确认框（空框只会让人困惑）', async () => {
    const harness = await advanceToConfirm(createHarness(), '   ');

    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.record.notifications.at(-1).level, 'warn');

    // "不弹确认框"和"什么都不显示"是两回事 —— 前者对，后者是 bug。
    // 第一版就是后者：用户说完话浮层直接消失，他只能猜。
    const view = harness.record.overlayCalls.at(-1);
    assert.notEqual(view, null, '空结果也要让用户看见');
    assert.doesNotMatch(String(view.text), /等待确认|发送/, '它不能是一个等待确认的空框');
  });

  it('识别失败时回到空闲并报出原因', async () => {
    const harness = createHarness();
    harness.state.transcribeError = new Error('无法连接转写服务');
    await advanceToConfirm(harness);

    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.record.notifications.at(-1).level, 'error');
  });

  it('超长：进确认框时就截断，框里显示的就是会发出去的内容', async () => {
    const harness = await advanceToConfirm(createHarness(), '一'.repeat(25));

    assert.equal(harness.machine.pending.length, 20, '确认框里只放会发出去的那 20 个字');
    const view = harness.record.overlayCalls.at(-1);
    assert.equal(view.text.length, 20, '浮层正文就是将要发出去的文本');
    assert.match(view.hint, /已截断到 20 字/, '要告知截断发生过');
    assert.doesNotMatch(view.hint, /一{5}/, '但不展示被截掉的内容 —— 它不会发出去');
  });

  it('超长**照样能发**（截断后直接发，让服务端裁决）', async () => {
    const harness = await advanceToConfirm(createHarness(), '一'.repeat(25));
    await harness.machine.handleKey('send');

    assert.equal(harness.record.sent.length, 1, '不该在本地拦下来 —— 服务端拒绝时会给出理由');
    assert.equal(harness.record.sent[0].length, 20);
    assert.equal(harness.machine.state, 'idle');
  });

  it('取消键恢复成纯取消：超长时按它也是取消，不是截断', async () => {
    // 这一条防的是一个很糟的误解：用户按 F10 想放弃这条，结果话被砍了一半还留着。
    const harness = await advanceToConfirm(createHarness(), '一'.repeat(25));

    await harness.machine.handleKey('cancel');

    assert.equal(harness.machine.state, 'idle', '必须真的取消掉');
    assert.equal(harness.record.sent.length, 0);
  });

  it('未超长时取消键就是取消，不发任何东西', async () => {
    const harness = await advanceToConfirm(createHarness());
    await harness.machine.handleKey('cancel');

    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.record.sent.length, 0);
    assert.equal(harness.record.overlayCalls.at(-1), null);
  });

  it('开始录音失败时不会卡在录音状态', async () => {
    const harness = createHarness();
    harness.state.startError = new Error('未找到 ffmpeg');
    await harness.machine.handleKey('record');

    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.record.notifications.at(-1).level, 'error');
  });
});

describe('状态机 —— 自动发送与超时', () => {
  it('开启自动发送后跳过确认，直接发出去', async () => {
    const harness = createHarness({ autoSend: true });
    await advanceToConfirm(harness);

    assert.deepEqual(harness.record.sent, ['今晚这波打得不错']);
    assert.equal(harness.machine.state, 'idle');
  });

  it('确认超时后自动取消（游戏里手一忙就会忘记它还挂着）', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const harness = createHarness({ confirmTimeoutSeconds: 5 });
    await advanceToConfirm(harness);
    assert.equal(harness.machine.state, 'confirm');

    t.mock.timers.tick(5000);

    assert.equal(harness.machine.state, 'idle');
    assert.equal(harness.machine.pending, '');
    assert.match(harness.record.notifications.at(-1).message, /自动取消/);
    t.mock.timers.reset();
  });

  it('超时设为 0 表示不自动取消', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const harness = createHarness({ confirmTimeoutSeconds: 0 });
    await advanceToConfirm(harness);

    t.mock.timers.tick(60000);

    assert.equal(harness.machine.state, 'confirm', '应该一直等着');
    t.mock.timers.reset();
  });

  it('dispose 之后定时器不再触发（否则会拖住进程）', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const harness = createHarness({ confirmTimeoutSeconds: 5 });
    await advanceToConfirm(harness);
    harness.machine.dispose();

    t.mock.timers.tick(10000);

    assert.equal(harness.machine.state, 'confirm', 'dispose 后不该再被定时器改动');
    t.mock.timers.reset();
  });
});
