/**
 * dsh-voice-danmaku —— 插件入口。
 *
 * ## 这个模块唯一的职责是"装配"
 *
 * 它把配置、sidecar、录音、识别、发送通道接成一个能工作的整体，
 * 然后在卸载时把一切拆干净。**业务规则不在这里** —— 那在 `machine.ts`，
 * 平台细节在 `channels/` 和 `asr/`，原生细节在 `sidecar/`。
 *
 * ## 装配顺序为什么是这样
 *
 * sidecar 要现场编译（首次运行）、要等 Windows 加载 .NET 运行时，所以它是
 * 异步的。而 DSH 的插件加载不应该被它拖住。因此：
 *
 *   1. 先同步注册设置命名空间（用户马上能在设置界面看到）；
 *   2. 再异步准备 sidecar，完成后才真正开始处理热键；
 *   3. 期间若有配置缺口，明确写进日志——静默失败是最难排查的东西。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { SettingsScope } from '@deepseek-ai/dsh-settings';
import type Schema from '@deepseek-ai/schemastery';

import {
  Config as ConfigSchema,
  SETTINGS_NAMESPACE,
  type VoiceDanmakuConfig
} from './config.js';
import { createAsrEngine } from './asr/registry.js';
import { createRecorder, enumerateAudioDevices, type AudioRecorder } from './audio.js';
import { DanmakuBridge, generateBridgeToken } from './bridge.js';
import { ffmpegMissingMessage, resolveFfmpeg } from './ffmpeg.js';
import { VoiceDanmakuMachine, type OverlayView } from './machine.js';
import { ComponentCache } from './wiring.js';
import { SidecarClient } from './sidecar-client.js';
import { ensureSidecar } from './sidecar-path.js';
import { describeKey, parseKey } from './keys.js';
import { error as logError, log, warn } from './logger.js';

/** 三个动作。普通按键与媒体键用同一套名字。 */
type VoiceAction = 'record' | 'send' | 'cancel';

/** cordis 插件名，出现在加载日志里。 */
export const name = 'voice-danmaku';

/**
 * sidecar 连续启动失败多少次后放弃重试。
 * 设成有限值是为了在"这个环境根本跑不起来"时不要无休止地刷日志；
 * 用户能看到明确的失败原因，而不是一堆重试噪音。
 */
const MAX_RESTART_ATTEMPTS = 5;

/** 我们依赖的服务。`settings` 缺失时会走组合层配置，插件照常工作。 */
export const inject = ['settings'];

/**
 * 插件配置 schema，导出给 cordis 的加载器使用（它会读这个具名导出）。
 *
 * 这里做一次类型断言，原因是两套 Schema 类型定义形状相同但名义不同：
 * DSH 服务用的是 `@deepseek-ai/dsh-settings` 里 `import type z` 的那个 Schema，
 * 我们的 schema 由 `@deepseek-ai/schemastery` 构造。两者是同一个库的同一份实现，
 * 只是在类型上没有互相引用。断言比复制一份 schema 更不容易出错。
 */
export const Config = ConfigSchema as unknown as Schema<VoiceDanmakuConfig>;

/**
 * 安装插件。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  /** 已注册的设置作用域。为 undefined 时说明 settings 服务不可用。 */
  let scope: SettingsScope<VoiceDanmakuConfig> | undefined;
  let sidecar: SidecarClient | undefined;
  let machine: VoiceDanmakuMachine | undefined;
  /** sidecar 自动重启的进度。 */
  let restartAttempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let keyActions: ReadonlyMap<number, VoiceAction> = new Map();
  let mediaActions: ReadonlyMap<number, VoiceAction> = new Map();

  /**
   * 本地桥：页面注入通道与 Chrome 扩展之间的那条线。
   *
   * 它是**插件级的单例**，而不是每次发送新建：扩展连在它上面，端口一换扩展就掉线。
   * 生命周期由 `syncBridge()` 跟着 `channel.provider` 走 —— 不用页面通道时它不该
   * 占着端口。
   */
  const bridge = new DanmakuBridge({ port: 0, token: '' });
  /** 桥当前监听的端口。用来发现"设置里改了端口"这件事。 */
  let bridgePort = 0;

  /**
   * 串行化 `syncBridge` 的队列。
   *
   * ⚠ **声明必须留在 `ctx.inject` 回调之前**。`ctx.inject` 的回调在服务就绪时
   * 会**同步**执行，而 `let` 在初始化前访问会抛 TDZ 错误
   * （"Cannot access 'bridgeQueue' before initialization"）。第一版把它写在
   * 回调下面，插件直接装不上 —— `tools/check-plugin.mjs` 当场抓到了。
   */
  let bridgeQueue: Promise<void> = Promise.resolve();
  /** 插件持有的定时器，卸载时统一清掉。同理，声明必须靠前。 */
  const timers: Array<ReturnType<typeof setInterval>> = [];
  /**
   * 上一次看到的"手动启动口令"值。
   *
   * 初值 -1 是刻意的：它表示"还没观察过"，于是第一次读到设置时只记录基线、
   * 不触发启动 —— 否则"插件读取自己的设置"这个动作本身就会拉起 sidecar，
   * 手动启动开关就失去意义了。
   */
  let lastLaunchToken = -1;

  /** 读取当前生效的设置。 */
  const settings = (): VoiceDanmakuConfig => {
    if (scope === undefined) throw new Error('设置服务尚未就绪');
    return scope.get();
  };

  // -------------------------------------------------------------------------
  // 设置注册
  // -------------------------------------------------------------------------
  ctx.inject(['settings'], (settingsCtx) => {
    scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, ConfigSchema, {
      applies: 'live',
      validate: (value) => {
        // 跨字段校验：同一个键不能兼两个动作，否则行为不可预测。
        // schema 表达不了这种"字段之间"的约束，所以放在 validate 里。
        assertDistinct(value.keys, '按键');
        // 媒体键只在启用时校验：默认值是给"打开开关"准备的建议键位，
        // 用户没启用时不该因为没动过的默认值而被拦住改不了别的设置。
        if (value.mediaKeys.enabled) assertDistinct(value.mediaKeys, '媒体键');
      }
    });

    // 设置变化时重新计算按键表并下发，不需要重启。
    scope.watch((next) => {
      rebuildKeyMap(next);
      if (sidecar?.running === true) sidecar.configure(toSidecarConfig(next));

      // 手动启动：设置页的「启动」按钮会递增 launchToken，值一变就拉起 sidecar。
      // 用"值变了"而不是"值为真"判断，这样连续点两次能各自触发一次。
      const token = next.behavior.launchToken;
      if (token !== lastLaunchToken) {
        const firstObservation = lastLaunchToken === -1;
        lastLaunchToken = token;
        // 首次观察只是记录基线，不能当成一次点击（否则"读过一次设置"就会启动）。
        if (!firstObservation) {
          log('收到手动启动请求，正在拉起…');
          void startSidecar().catch((cause: unknown) => {
            const reason = cause instanceof Error ? cause.message : String(cause);
            logError('手动启动失败:', reason);
          });
        }
      }

      // 同步"哪些密钥已填写"的派生字段，供设置页显示遮罩。
      syncSecretStatus(next);

      // 本地桥跟着通道选择起停（串行，见 queueSyncBridge）。
      queueSyncBridge(next);
    });

    rebuildKeyMap(scope.get());
    syncSecretStatus(scope.get());
    // 首次也要同步一次：桥必须在插件启动时就起来，而不是等到第一次发送 ——
    // 扩展会自己来连，桥晚起一秒它就多转一圈。
    queueSyncBridge(scope.get());
    startBridgeStatusWatch();
    log('设置已注册，命名空间:', SETTINGS_NAMESPACE);
  });

  /**
   * 把"哪些密钥已填写"回写到 `behavior.secretStatus`。
   *
   * ## 为什么这件事只能宿主做
   *
   * DSH 描述符里的 secret `set` 标记看起来正合用，但实测不可用：`describe()` 用
   * **解析后的值**做 redact，而密钥字段的 schema 默认是空字符串，
   * `'' !== undefined` 恒为真 —— 每个密钥都被报成"已设置"。
   *
   * 只有宿主拿得到真实值（客户端永远拿不到，这是 DSH 的刻意设计），所以判断在
   * 这里做，结论写进一个**非密钥**字段给客户端读。
   *
   * 只在结果变化时写，避免每次设置变动都产生一次无意义的写入（那会污染设置文档）。
   */
  function syncSecretStatus(config: VoiceDanmakuConfig): void {
    if (scope === undefined) return;

    // 这是"哪些字段算密钥"的唯一定义处，新增密钥字段时记得加进来。
    // 现在只剩 ASR 密钥一个 —— 弹幕通道不再需要任何凭证（请求由页面自己发）。
    const candidates: Array<[string, string]> = [
      ['asr.apiKey', config.asr.apiKey]
    ];
    const next = candidates
      .filter(([, value]) => value.trim().length > 0)
      .map(([path]) => path);

    const current = config.behavior.secretStatus;
    if (current.length === next.length && current.every((item, i) => item === next[i])) return;

    // 打一行日志。这一步是刻意加的：设置页上"密钥是否被识别为已填写"是一个
    // 只能间接观察的状态，排查时最缺的就是"宿主到底算出了什么"。
    // 有这行就不必再写临时脚本去猜（我为此浪费过好几次时间，而且临时脚本本身
    // 出过三次错，每次都产生假线索）。
    log(`密钥状态: [${next.join(', ')}]`);

    void scope.update({ behavior: { secretStatus: next } }).catch((cause: unknown) => {
      // 写失败不影响功能，只是遮罩会不准，所以只记日志。
      const reason = cause instanceof Error ? cause.message : String(cause);
      warn('回写密钥状态失败:', reason);
    });
  }

  /**
   * 把 sidecar 回报的媒体键注册结果写进设置，供设置页显示。
   *
   * 与 `syncSecretStatus` 同一个套路：**结论只能由宿主算/收，客户端读一个
   * 非密钥字段**。这里的原因是 `RegisterHotKey` 的失败是静默的 —— 不写出来，
   * 用户面对"按这个键没反应"没有任何可查的线索。
   *
   * 只在变化时写，避免每次 configure 都产生一次设置写入。
   */
  function syncMediaReport(raw: string): void {
    if (scope === undefined) return;

    // `ok=` 表示"一个都没注册，因为压根没启用"。那是**没有信息**，不是"注册结果
    // 为空"，所以不落盘 —— 否则用户文档里会多一个恒为 `ok=` 的键，
    // 设置页也得为它多写一个分支。
    const report = raw === 'ok=' ? '' : raw;

    if (scope.get().behavior.mediaKeysReport === report) return;
    void scope.update({ behavior: { mediaKeysReport: report } }).catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      warn('回写媒体键注册结果失败:', reason);
    });
  }

  /**
   * 让本地桥的状态跟上配置。
   *
   * ## 为什么桥不总是开着
   *
   * 桥是一个监听着端口的服务。"用不到也开着"有两个代价：占着一个端口，
   * 以及多一个本机程序可以连进来的入口。所以它严格跟着 `channel.provider` 走：
   * 选了页面通道就起来，换回 HTTP 就关掉。
   *
   * ## 口令为什么要回写
   *
   * 用户没有理由自己发明一个口令，所以留空时宿主生成一个写回设置 ——
   * 但它必须**看得见**（用户要把它复制到扩展选项页里），因此它不是 secret 字段。
   * 这和 `secretStatus` 那种"派生状态"不同：这是一个真实生效的配置值。
   */
  async function syncBridge(config: VoiceDanmakuConfig): Promise<void> {
    if (scope === undefined) return;

    if (config.channel.provider !== 'page') {
      if (bridge.snapshot.listening) {
        await bridge.stop();
        bridgePort = 0;
        log('已停用本地桥（当前发送通道不是 page）');
      }
      return;
    }

    const token = config.channel.page.token.trim();
    if (token.length === 0) {
      const generated = generateBridgeToken();
      log('本地桥口令为空，已生成一个新的并写回设置');
      try {
        await scope.update({ channel: { page: { token: generated } } });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        warn('回写本地桥口令失败:', reason);
        return;
      }
      // 这次写入会再触发一遍本函数（设置变化），那时口令已经就位。
      return;
    }

    bridge.setToken(token);

    // 目标直播间号。**它只在开着多个直播间时才会被用来筛选**：
    //   * 只开一个直播间 → 填没填都直接发（没有歧义，不该因为地址对不上就拦）；
    //   * 开了多个 + 填了 → 发给匹配的那个；
    //   * 开了多个 + 没填 → 拒绝发送，让用户去关掉多余的。
    // 判断逻辑在桥里（只有它知道开了几个），这里只把值传下去。
    bridge.setTargetRoomId(config.channel.roomId);

    // 端口变了要重开：桥一旦启动就固定在那个端口上。
    if (bridge.snapshot.listening && bridgePort !== config.channel.page.port) {
      await bridge.stop();
      bridgePort = 0;
    }

    if (!bridge.snapshot.listening) {
      try {
        bridgePort = await bridge.start(config.channel.page.port);
        log(`本地桥已就绪：http://127.0.0.1:${bridgePort}（等 Chrome 扩展来连）`);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        logError('本地桥启动失败:', reason);
        warn('页面注入通道暂时不可用。若端口被别的程序占用，可以在设置里换一个。');
      }
    }
  }

  /**
   * 串行化 `syncBridge`：设置可能连续变动（比如用户拖动数字输入框），而启动/停止
   * 桥是异步的 —— 两次并发调用会看到同一个"没在监听"的状态，于是两个 start 撞在
   * 同一个端口上。排队执行就不会有这个问题。
   */
  function queueSyncBridge(config: VoiceDanmakuConfig): void {
    bridgeQueue = bridgeQueue
      .then(() => syncBridge(config))
      .catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        warn('同步本地桥状态失败:', reason);
      });
  }

  /**
   * 把桥的连接状态写进设置，供设置页显示。
   *
   * ## 为什么这件事必须定期做
   *
   * 别处的派生字段（密钥是否已填、媒体键注册结果）都是"事件驱动"的：收到回执
   * 就写一次。桥的状态不是事件 —— 扩展**随时可能**关掉标签页、禁用扩展、
   * 退出浏览器，而这些都不会给插件发任何消息。所以只能定期看。
   *
   * 5 秒一次、且只在结论变化时写：设置文档不该被无意义的写入刷满。
   */
  function startBridgeStatusWatch(): void {
    const timer = setInterval(() => {
      if (disposed || scope === undefined) return;
      const next = describeBridgeStatus();
      if (scope.get().channel.page.status === next) return;
      void scope.update({ channel: { page: { status: next } } }).catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        warn('回写本地桥状态失败:', reason);
      });
    }, 5000);
    // 定时器不该拖住插件卸载。
    if (typeof timer.unref === 'function') timer.unref();
    timers.push(timer);
  }

  /** 把桥的几段链路压缩成一个状态值。 */
  function describeBridgeStatus(): string {
    if (scope === undefined) return '';
    if (scope.get().channel.provider !== 'page') return 'off';
    const snapshot = bridge.snapshot;
    if (!snapshot.listening) return 'down';
    if (!bridge.extensionOnline) return 'waiting';

    // 能不能发、发给谁 —— 判断在桥里（只有它知道开着几个直播间）。
    // 被拒绝时归入 not-ready；具体原因由桥记着，设置页会把它显示出来。
    const plan = bridge.planDispatch();
    if ('refuse' in plan) return 'not-ready';

    const target = snapshot.tabs.find((tab) => tab.id === plan.tabId);
    if (target === undefined || !target.ready) {
      return snapshot.page !== undefined && snapshot.page.error.length > 0
        ? 'page-error'
        : 'not-ready';
    }
    return 'ready';
  }

  /** 把配置里的按键名解析成 `键码 → 动作` 表。 */
  function rebuildKeyMap(config: VoiceDanmakuConfig): void {
    keyActions = buildMap(
      [
        [config.keys.record, 'record'],
        [config.keys.send, 'send'],
        [config.keys.cancel, 'cancel']
      ],
      '按键'
    );

    // 媒体键与普通键各自成表，由 sidecar 上报的 `source` 决定查哪一张。
    // 不做"合并成一张表"是因为同一个键码可能同时出现在两边（用户可以把 F9
    // 也填进媒体键），合并会让两边互相覆盖，行为取决于遍历顺序。
    mediaActions = config.mediaKeys.enabled
      ? buildMap(
          [
            [config.mediaKeys.record, 'record'],
            [config.mediaKeys.send, 'send'],
            [config.mediaKeys.cancel, 'cancel']
          ],
          '媒体键'
        )
      : new Map();

    const summary = [...keyActions.entries()]
      .map(([code, action]) => `${describeKey(code)}→${action}`)
      .join(' ');
    log('按键映射:', summary);
    if (config.mediaKeys.enabled) {
      const mediaSummary = [...mediaActions.entries()]
        .map(([code, action]) => `${describeKey(code)}→${action}`)
        .join(' ');
      log('媒体键映射:', mediaSummary);
    } else {
      // 未启用也要说一句。媒体键的"没反应"和"没启用"在现象上完全一样，
      // 而设置页里那三个键填好了却忘了打开总开关是非常容易发生的事
      // （实测发生过：用户填了两个键就以为配好了，按下去毫无反应）。
      // 日志里留一行，排查时至少不用猜。
      log('媒体键: 未启用（设置 → 语音弹幕 → 媒体键 → 启用媒体键，打开后才会注册）');
    }
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  // 首次启动失败也要走重试：`ensureSidecar()` 里包含"首次运行时现场编译"，
  // 而编译可能因为暂时性原因失败（文件占用、磁盘忙）。只报错不重试会让插件
  // 一直不可用，直到用户重启 DSH——而重启正是用户最不愿意做的事。
  void start().catch((cause: unknown) => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    logError('插件启动失败:', reason);
    scheduleRestart();
  });

  async function start(): Promise<void> {
    // 等设置注册完成（ctx.inject 是异步触发的）。
    const config = await waitForSettings();
    if (disposed) return;

    // 启动前的配置缺口只汇报一次；之后配置变化由设置监听负责。
    reportConfigurationGaps(config);

    // 关闭了"随 DSH 启动"就不拉起 sidecar —— 不装全局钩子、不留托盘图标。
    // 用户需要时在设置页点「启动」。
    if (!config.behavior.autoStart) {
      log('已按设置关闭"随 DSH 启动"。需要时在 设置 → 语音弹幕 点「启动」。');
      return;
    }

    await launch();
    log('就绪。按', config.keys.record, '开始说话。');
  }

  // -------------------------------------------------------------------------
  // sidecar 生命周期与自动恢复
  // -------------------------------------------------------------------------

  /**
   * 确保有一个已接好事件处理的客户端。
   *
   * 幂等：`launch()` 在首次启动和每次重试时都会调它，而重试不能每次新建一个
   * 客户端（否则会留下多个互不知晓的实例）。
   */
  function ensureClient(): SidecarClient {
    if (sidecar !== undefined) return sidecar;

    const client = new SidecarClient();
    sidecar = client;

    client.on('key', (event) => {
      if (event.phase !== 'down') return;
      // 媒体键与普通键查不同的表：两条通道可能同时盯着同一个键码，
      // 用 source 分流才不会出现"两个动作抢一次按键"。
      const table = event.source === 'media' ? mediaActions : keyActions;
      const action = table.get(event.vk);
      if (action === undefined) return;
      log(`热键 ${event.key}（${event.source === 'media' ? '媒体键' : '键盘'}，前台：${event.foreground}）`);
      // 机器还没起来（sidecar 正在重启）时静默忽略：这不是用户能处理的错误，
      // 弹提示只会让人困惑。真正的原因在日志里。
      void machine?.handleKey(action);
    });
    client.on('configured', (applied) => {
      // 媒体键注册失败是**静默**的（键被别的程序占用），只能靠这条回执发现。
      // 写进设置里的一个派生字段，让设置页能直接显示出来。
      //
      // 这里必须传 `mediaKeysReport`（形如 `ok=AudioVolumeMute failed=...` 的回执），
      // **不是** `mediaKeys`（那是 `173,176,179` 这样的键码表）。两者只差一个词，
      // 而传错的表现是"设置页上那行状态永远不出现"—— 完全静默，没人会发现。
      // tools/check-media-report.mjs 用一个真 sidecar 把这件事钉住了。
      log('sidecar 已应用配置，媒体键:', applied.mediaKeysReport || '（未启用）');
      syncMediaReport(applied.mediaKeysReport);
    });
    client.on('failure', (cause) => logError('sidecar:', cause.message));
    client.on('exited', ({ code, signal, intentional }) => {
      // 进程死了，机器得回到干净状态，否则会卡在"识别中"永远不发。
      machine?.dispose();
      machine = undefined;

      // 用户从托盘菜单点的退出：必须尊重，不能自愈重启。
      // 否则表现为"点了退出它又自己冒出来，根本关不掉"。
      if (intentional) {
        log('sidecar 已按用户要求退出。要恢复语音功能，请重启 DSH。');
        return;
      }

      const detail = code === null ? `signal ${signal ?? 'unknown'}` : `退出码 ${code}`;
      warn(`sidecar 意外退出（${detail}），将自动重启`);
      scheduleRestart();
    });
    client.on('moved', ({ x, y }) => {
      // 用户拖过浮层：记下来，方便下次调整默认位置时参考。
      log(`浮层被拖到 (${x}, ${y})`);
    });

    return client;
  }

  /**
   * 启动（或重启）sidecar，成功后就绪。
   *
   * 这是唯一的启动入口：首次启动、崩溃恢复、启动失败重试都走这里，
   * 所以"客户端创建 + 事件接线 + 进程拉起 + 机器重建"这套动作只有一份实现。
   */
  async function launch(): Promise<void> {
    const client = ensureClient();

    // 保险：确认上一个实例真的退出了再拉起新的。
    //
    // 为什么需要：`stop()` 最多等 1.5 秒就放弃（超时后强杀），所以理论上存在
    // 「旧进程还在退出、新进程已经起来」的窗口。两个 sidecar 会各装一个全局
    // 钩子并争抢同一次按键，表现为状态机被触发两次（浮层闪一下、甚至重复发送）。
    // 这个窗口极窄，但一旦发生很难排查，所以在这里等它干净退出。
    if (client.running) {
      warn('检测到上一次的 sidecar 尚未退出，先把它停干净再启动');
      await client.stop();
    }

    const exePath = await ensureSidecar();
    if (disposed) return;
    await client.start(exePath);
    if (disposed) {
      await client.stop();
      return;
    }

    machine = createMachine();
    restartAttempts = 0;
    client.configure(toSidecarConfig(settings()));
  }

  /**
   * 手动启动 sidecar（设置页的「启动」按钮）。
   *
   * 幂等：已经在跑就什么都不做。用户点按钮时不该发生"又起一个"这种事——
   * 两个 sidecar 会各装一个全局钩子抢同一次按键。
   */
  async function startSidecar(): Promise<void> {
    if (disposed) return;
    if (sidecar?.running === true) {
      log('sidecar 已在运行，忽略手动启动请求');
      return;
    }
    await launch();
    log('sidecar 已手动启动，热键可用。');
  }

  /**
   * 安排一次自动重启。
   *
   * 为什么必须自动重启：sidecar 一旦死掉而没人管，插件就变成"按什么都没反应"
   * 的僵尸——用户不会去看日志，只会认为插件坏了。退避是为了避免"一启动就崩"
   * 时变成疯狂重试。
   */
  function scheduleRestart(): void {
    if (disposed) return;
    if (restartTimer !== undefined) return;

    restartAttempts += 1;
    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      logError(
        `sidecar 连续 ${MAX_RESTART_ATTEMPTS} 次启动失败，已停止重试。` +
        '语音热键将不可用，请查看上面的错误原因，修复后重启 DSH。'
      );
      return;
    }

    const delayMs = Math.min(1000 * 2 ** (restartAttempts - 1), 15000);
    warn(`将在 ${Math.round(delayMs / 1000)} 秒后尝试重启 sidecar（第 ${restartAttempts} 次）`);

    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (disposed) return;
      void (async () => {
        try {
          await launch();
          log('sidecar 已恢复，热键重新可用');
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          logError('sidecar 重启失败:', reason);
          scheduleRestart();
        }
      })();
    }, delayMs);
  }

  /** 轮询等待设置作用域就绪。 */
  async function waitForSettings(timeoutMs = 10000): Promise<VoiceDanmakuConfig> {
    const deadline = Date.now() + timeoutMs;
    while (scope === undefined) {
      if (disposed) throw new Error('插件已卸载');
      if (Date.now() > deadline) {
        throw new Error('等待设置服务超时。DSH 可能未加载 settings 服务。');
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    return scope.get();
  }

  /** 把配置缺口写进日志。不阻止启动 —— 用户可能只想先看浮层效果。 */
  function reportConfigurationGaps(config: VoiceDanmakuConfig): void {
    const problems: string[] = [];
    try {
      problems.push(...createAsrEngine(config).check());
    } catch (cause) {
      problems.push(`识别引擎不可用：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    // 发送通道的 check() 是异步的，不能阻塞启动。而且它缺的东西只有运行时才知道
    // （扩展有没有连上、直播间页面开着没有），所以启动阶段不报它的缺口 ——
    // 那两件事在设置页上有实时状态，比启动时的一句日志有用得多。
    //
    // 这里能同步判定的只剩一句提醒：没填直播间号时，任何直播间页面都会被接受。
    if (config.channel.roomId.trim().length === 0) {
      log('未设置直播间号：任何直播间页面都会被接受（想只认某一个房间就把它填上）。');
    }

    if (problems.length > 0) {
      warn('以下配置尚未完成，语音输入暂时无法走通：');
      for (const problem of problems) warn(`  · ${problem}`);
    }

    reportFfmpeg(config);
  }

  /**
   * 探测 ffmpeg 并把结论写进日志。
   *
   * 这一步值得单独做，因为"装没装 ffmpeg"是用户在设置页里无法自己判断的事情：
   * 探测成功就明确告诉他**用上了哪个路径**（省得怀疑是不是没生效），
   * 失败就给出安装命令和已经找过的位置。
   *
   * 参数是显式传入的配置，**不能在这里调 `settings()`**：本函数在启动早期就被
   * 调用，那时设置作用域可能还没就绪，`settings()` 会抛"设置服务尚未就绪"，
   * 把整个启动流程带崩。
   */
  function reportFfmpeg(config: VoiceDanmakuConfig): string | undefined {
    const resolution = resolveFfmpeg(config.audio.ffmpegPath);
    if (resolution.path !== undefined) {
      log(`ffmpeg: ${resolution.path}`);
      return resolution.path;
    }
    // 找不到不是致命错误（用户可能只想先看浮层），但要说清楚到哪一步为止。
    log(ffmpegMissingMessage(resolution.checked));
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 状态机的依赖注入
  // -------------------------------------------------------------------------

  /**
   * 长生命周期对象的缓存。
   *
   * 为什么这件事必须交给一个专门的类（而不是就地写两个变量）：
   * 这里曾经有过一个真实的 bug —— 每次发送都新建通道实例，把频率限制
   * 完全清零。通道自己的单元测试发现不了它，因为错的是创建方式。
   * 所以决策被集中到 `ComponentCache` 并单独测试，见 test/wiring.test.mjs。
   */
  const components = new ComponentCache({ bridge });

  /**
   * 录音器及其解析出的 ffmpeg 路径。
   *
   * 路径要在**首次录音时**才解析（而不是插件启动时）：用户可能先装 ffmpeg 再回来用，
   * 提前解析会把"当时没装"这个事实固化成失败状态。这里缓存的是"已解析出的路径"，
   * 配置一改就失效重解析。
   */
  let recorder: AudioRecorder | undefined;
  let recorderKey = '';
  /** ffmpeg 自检是否已经通过。通过之后不再重复跑（每次省几十到一百多毫秒）。 */
  let probePassed = false;

  /**
   * 取录音器，必要时先解析 ffmpeg 路径与录音设备名。
   *
   * 两件事都必须在这里解析，因为它们都是"环境事实"而不是用户输入：
   *   * ffmpeg 装在哪 —— 见 src/ffmpeg.ts；
   *   * 麦克风叫什么 —— dshow **不接受 `default` 这种写法**，必须用确切设备名，
   *     所以第一版写死 `audio=default` 是必然失败的。这个 bug 由真机测试暴露。
   *
   * 缓存键包含路径与设备名，任一变化就重建。
   *
   * @throws 找不到 ffmpeg 或找不到麦克风时，抛出带指引的错误。
   */
  async function recorderFor(): Promise<AudioRecorder> {
    const current = settings();
    const resolution = resolveFfmpeg(current.audio.ffmpegPath);

    if (resolution.path === undefined) {
      // 把已探测过的位置一并带出来：用户才能判断是该装还是该手填路径。
      throw new Error(ffmpegMissingMessage(resolution.checked));
    }

    const deviceName = await resolveDeviceName(resolution.path, current.audio.device);
    const key = `${resolution.path}\u0000${deviceName}`;

    if (recorder === undefined || recorderKey !== key) {
      recorder = createRecorder({ ffmpegPath: resolution.path, deviceName });
      recorderKey = key;
      // 换了 ffmpeg 或设备就要重新自检 —— 旧结论对新组合没有意义。
      probePassed = false;
    }
    return recorder;
  }

  /**
   * 确定要用的录音设备名。配置里填了就用它，否则枚举后取第一个。
   *
   * 为什么默认取第一个而不是报错让用户选：单麦克风的机器上这就是唯一正确解，
   * 而多麦克风时"第一个"通常也是系统默认设备。真选错了，配置里能改。
   */
  async function resolveDeviceName(ffmpegPath: string, configured: string): Promise<string> {
    const wanted = configured.trim();
    if (wanted.length > 0) return wanted;

    const { devices, raw } = await enumerateAudioDevices(ffmpegPath);
    const first = devices[0];
    if (first === undefined) {
      throw new Error(
        '没有找到可用的录音设备。\n' +
        '请确认麦克风已插好、且在「设置 → 系统 → 声音 → 输入」里被识别。\n' +
        (raw.trim().length > 0
          ? `ffmpeg 的设备枚举输出（末尾）：\n${raw.trim().slice(-400)}`
          : '')
      );
    }
    log(`录音设备: ${first}${devices.length > 1 ? `（共 ${devices.length} 个，可在设置里指定）` : ''}`);
    return first;
  }

  function createMachine(): VoiceDanmakuMachine {
    return new VoiceDanmakuMachine(
      {
        async startRecording() {
          const active = await recorderFor();
          // 自检**只做一次**（成功后缓存）。
          //
          // probe() 会真的跑一遍 `ffmpeg -version`，几十到一百多毫秒。它原本在
          // **每次**录音前都跑，于是"按下键之后还要等一会儿才开录"—— 而说两三个
          // 字（半秒左右）的人，话就丢在这段等待里。失败结果刻意不缓存：
          // 用户可能刚把 ffmpeg 装好，下一次就该重试。
          if (!probePassed) {
            const probe = await active.probe();
            if (!probe.available) {
              throw new Error(
                `${probe.detail}。找到了 ffmpeg（${recorderKey}）但它无法运行，` +
                '可能是文件损坏或架构不匹配；删掉设置里的「ffmpeg 位置」让它重新自动探测。'
              );
            }
            probePassed = true;
          }
          // 等设备真的开始输出数据（见 audio.ts 的 start()）。这一行返回之后响的
          // 提示音才代表"现在可以说了"。
          await active.start();
        },
        async stopRecording() {
          return (await recorderFor()).stop();
        },
        async transcribe(audio) {
          // 引擎是无状态的，每次按最新设置重建，改了密钥/模型立刻生效。
          const current = settings();
          const engine = createAsrEngine(current);
          return engine.transcribe({
            audio,
            language: current.asr.language,
            timeoutMs: current.asr.timeoutMs
          });
        },
        async send(text) {
          // 用缓存的实例，保住限流状态。
          const result = await components.channelFor(settings()).send(text);

          // **结果未知**要原样交给状态机（它会锁住输入直到结果明确）。
          // 在这里把它降级成"失败"会让用户重说一遍再发一次，而这条可能已经
          // 发出去了 —— 直播间里就是两条一模一样的话。
          if (result.unsure === true) {
            return { unsure: true as const, reason: result.error ?? '扩展没有说明原因' };
          }

          // 通道把业务性拒绝放在返回值里，状态机只认异常，所以这里翻译一次。
          if (!result.ok) throw new Error(result.error ?? '发送被拒绝');
        },
        overlay(view: OverlayView | null) {
          const client = sidecar;
          if (client?.running !== true) return;
          const current = settings();
          if (!current.overlay.enabled) {
            // 浮层被关闭时仍然要隐藏已有的浮层，否则关掉设置后会留一个残影。
            client.hide();
            return;
          }
          if (view === null) {
            client.hide();
            return;
          }
          client.show({
            text: view.text,
            accent: view.accent,
            hint: view.hint,
            showHint: view.showHint
          });
        },
        sound(kind) {
          if (!settings().behavior.soundFeedback) return;
          // 提示音交给 sidecar 播 —— 它是常驻的原生进程，零进程开销。
          //
          // **不要改回 spawn powershell**：那样每按一次键就会启动一个
          // powershell.exe，而那是恶意软件的高频特征，安全软件会对它格外上心。
          // 这个工具只是想"嘀"一声，没有理由把 powershell 牵扯进来。
          //
          // sidecar 不在时静默跳过：那种情况下热键本来也不工作（热键来自 sidecar），
          // 不会有"按了没反应又没有反馈"的场景。
          if (sidecar?.running === true) {
            sidecar.beep(
              BEEP_TONES[kind].map(([frequency, duration]) => `${frequency}:${duration}`).join(',')
            );
          }
        },
        notify(message, level) {
          if (level === 'error') logError(message);
          else if (level === 'warn') warn(message);
          else log(message);
        }
      },
      () => {
        const current = settings();
        return {
          soundFeedback: current.behavior.soundFeedback,
          autoSend: current.behavior.autoSendOnRecognized,
          // 长度上限现在是设置项（默认 20）。用配置值而不是那个常量 ——
          // 常量只是为了给 schema 提供一个默认值。
          maxLength: current.channel.maxLength,
          confirmTimeoutSeconds: current.behavior.confirmTimeoutSeconds
        };
      }
    );
  }

  // -------------------------------------------------------------------------
  // 配置 → sidecar 协议载荷
  // -------------------------------------------------------------------------
  function toSidecarConfig(config: VoiceDanmakuConfig): Parameters<SidecarClient['configure']>[0] {
    const codes = [...keyActions.keys()];
    // 媒体键未启用时下发空串，sidecar 会据此注销所有媒体键热键 ——
    // 这样"关掉开关"能立刻把键还给别的程序，不需要重启。
    const mediaCodes = config.mediaKeys.enabled ? [...mediaActions.keys()] : [];
    return {
      keys: codes.join(','),
      mediaKeys: mediaCodes.join(','),
      consumeKeys: config.behavior.consumeKeys,
      fontSize: config.overlay.fontSize,
      padding: config.overlay.padding,
      marginTop: config.overlay.marginTop,
      opacity: config.overlay.opacity,
      anchorXPercent: config.overlay.anchorXPercent,
      maxWidthPercent: config.overlay.maxWidthPercent,
      reassertSeconds: config.overlay.reassertSeconds,
      clickThrough: config.overlay.clickThrough,
      draggable: config.overlay.draggable
    };
  }

  // -------------------------------------------------------------------------
  // 卸载
  // -------------------------------------------------------------------------
  // 用 ctx.effect 而不是 ctx.on('dispose')：cordis 的 effect 是注册清理逻辑的
  // 正规入口，且它会在插件 fiber 卸载时按逆序执行，能保证 sidecar 先被停掉。
  ctx.effect(() => () => {
    disposed = true;
    // 先取消待执行的重启，否则卸载后还会拉起一个新进程。
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    // 状态巡检的定时器也要停，否则卸载后它还会去写一个已经没有作用域的设置。
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    machine?.dispose();
    machine = undefined;
    // 录音器可能正抓着一个 ffmpeg 子进程，必须主动中断，否则它会一直录下去。
    recorder?.abort();
    recorder = undefined;
    recorderKey = '';
    // 通道实例由 ComponentCache 持有，交给它统一释放。
    components.dispose();
    // 桥只是个本地 HTTP 服务，但留着它等于留着一个开着端口的进程内服务。
    void bridge.stop().catch((cause: unknown) => {
      logError('停止本地桥失败:', cause);
    });
    // 必须等 sidecar 真的退出：留一个抓着全局热键的孤儿进程是最糟的结局。
    void sidecar?.stop().catch((cause: unknown) => {
      logError('停止 sidecar 失败:', cause);
    });
    sidecar = undefined;
    log('插件已卸载');
  });
}

/**
 * 把一组 `配置写法 → 动作` 解析成 `键码 → 动作`，无法识别的只警告不抛错。
 *
 * 校验（validate）已经在设置写入时拦过一遍，所以这里的兜底路径正常走不到——
 * 它存在是为了"设置文件被手改坏"这种情况：那种时候用户最需要的是插件照常
 * 启动、日志里说明白哪个键没生效，而不是整个插件加载失败。
 */
function buildMap(pairs: Array<[string, VoiceAction]>, label: string): Map<number, VoiceAction> {
  const map = new Map<number, VoiceAction>();
  for (const [raw, action] of pairs) {
    const code = parseKey(raw);
    if (code === undefined) {
      warn(`${label} ${action} = 「${raw}」无法识别，该动作将不可用`);
      continue;
    }
    map.set(code, action);
  }
  return map;
}

/**
 * 校验一组按键里没有重复。
 *
 * 重复的后果不是"后一个覆盖前一个"这么好猜：两个动作会绑在同一个键上，
 * 而 sidecar 只上报一次按键，于是**哪个动作生效取决于查表顺序**——
 * 表现为"有时候发送、有时候取消"这种极难复现的问题。所以宁可直接拒绝。
 */
function assertDistinct(
  group: { record: string; send: string; cancel: string },
  label: string
): void {
  const codes = new Map<number, string>();
  for (const action of ['record', 'send', 'cancel'] as const) {
    const raw = group[action];
    const code = parseKey(raw);
    if (code === undefined) {
      throw new Error(
        `${label} ${action} = 「${raw}」无法识别。` +
        '可用 F1–F24、PageUp、Num0 等名字，或 MediaPlayPause、AudioVolumeMute 这类媒体键名，' +
        '也可以直接写键码数字。'
      );
    }
    const existing = codes.get(code);
    if (existing !== undefined) {
      throw new Error(`${label}「${raw}」被 ${existing} 和 ${action} 同时使用，请改成不同的键。`);
    }
    codes.set(code, action);
  }
}

/**
 * 各类反馈的提示音，`[频率, 毫秒]` 序列。
 *
 * 音调设计：上行音（确认/成功）与下行音（失败）不需要学习就能分辨，
 * 比让人记住四个音调更省注意力。用 `Console.Beep` 而不是发 BEL 字符：
 * BEL 在所有终端里都是同一个音，无法区分"录完了"和"失败了"。
 */
const BEEP_TONES: Record<'start' | 'stop' | 'confirm' | 'sent' | 'error', Array<[number, number]>> = {
  start: [[880, 90]],
  stop: [[660, 90]],
  confirm: [[988, 70], [1319, 110]],
  sent: [[1319, 90]],
  error: [[440, 160], [330, 200]]
};
