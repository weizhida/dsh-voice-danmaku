/**
 * 本地桥：插件 ↔ Chrome 扩展之间的那条线。
 *
 * ## 它是什么
 *
 * 一个只监听 `127.0.0.1` 的极小 HTTP 服务。浏览器扩展每隔几百毫秒来问一次
 * "有没有要发的弹幕"，拿到就把字填进直播间页面、点发送；发完把页面自己收到的
 * 服务端回执送回来。
 *
 * ## 为什么是 HTTP 轮询，而不是 WebSocket
 *
 * WebSocket 能做到零延迟，但代价是**必须让扩展的 service worker 一直活着**：
 * MV3 的 SW 空闲 30 秒就被回收，所以得靠一条 20 秒一次的 ping 心跳把它吊住
 * （Chrome 116 才允许 WebSocket 活动延长 SW 寿命，官方为此专门写了一篇教程）。
 * 那是一条会**静默断掉**的依赖 —— 断了以后表现是"按了没反应"，没有任何提示。
 *
 * 轮询把这条依赖整个删掉了：不要求 SW 活着，只要求它**被叫醒时能干一次活**。
 * 而消息唤醒是可靠的。代价是每次发送多 0.8 秒以内的延迟 —— 对一个
 * "按一下键、等着弹幕出现在屏幕上"的用途完全无感。
 *
 * ## 安全
 *
 * 三个要点，缺一不可：
 *
 * 1. **只绑 127.0.0.1**，绝不监听 0.0.0.0 —— 否则同一局域网里任何人都能发弹幕。
 * 2. **口令（token）**。网页里的 JS 也能往本机端口发请求（`fetch('http://127.0.0.1:...')`
 *    是合法的），所以端口本身就是"公开"的。口令是唯一的门。扩展侧的请求带上它，
 *    网页脚本猜不到。
 * 3. **不发 CORS 头**。这样即使网页猜到了口令，浏览器也不让它的 JS 读到响应。
 *    扩展的请求走 service worker 的 host_permissions，本来就不需要 CORS 头。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { log, warn } from './logger.js';

/** 扩展上报的页面状态。用于在设置页回答"它到底连上没有、页面准备好了没"。 */
export interface BridgePageStatus {
  /** 直播间页面地址。 */
  href: string;
  /** 页面标题。 */
  title: string;
  /** 页面上找到了弹幕输入框。 */
  hasInput: boolean;
  /** 页面上找到了发送按钮。 */
  hasButton: boolean;
  /** 扩展自己遇到的最近一次错误（选择器找不到、点击被拒等）。 */
  error: string;
  /**
   * 页面世界的钩子装好了吗。
   *
   * 它决定我们拿不拿得到服务端的 `code`。装不上时（Chrome 低于 111 时
   * `world: "MAIN"` 不生效，或页面改版）只能靠"输入框有没有被清空"来判断，
   * 那是个弱得多的信号 —— 所以要报出来，排查时才知道该怀疑哪一层。
   */
  hookReady: boolean;
  /**
   * 最近一次发送是哪条触发路径生效的：`click` / `mouse-sequence` / `enter-key` /
   * `none`（三种都没生效）/ 空串（还没发过）。
   *
   * 为什么值得占一个字段：不同前端实现认不同的事件，而这个事实**只存在于页面里**，
   * 用户在浏览器里看不到、插件日志里也没有。第一版只发 `click()` 时，
   * 正是靠这一条才定位到"点击根本没生效"。
   */
  lastTrigger: string;
  /** 最近一次用的填字写法：`execCommand` / `native-setter` / `contenteditable`。 */
  fillMode: string;
  /**
   * 填入文字之后「发送」按钮是否仍然是禁用的。
   *
   * 这是**判断"页面到底认没认这次输入"的唯一客观依据**：按钮的可用状态由页面
   * 自己根据内部输入状态算出来，而我们只能看到 DOM 的 value —— 两者可以不一致。
   * 实测踩到过：value 里明明有字，页面却认为内容为空，于是三种点击方式全都没反应。
   */
  buttonDisabled: boolean;
  /** 最近一次找到的输入框长什么样（`<textarea class="…" placeholder="…">`）。 */
  inputElement: string;
  /** 最近一次找到的发送按钮长什么样。 */
  buttonElement: string;
  /**
   * 用户此刻在输入框里打了什么（截断）。
   *
   * 它能证明"扩展找的输入框就是他真正在用的那个"：如果他在页面上打的字这里
   * 读不到，那就是找错元素了。
   */
  inputValue: string;
  /**
   * 页面自己发出去的 POST 请求（JSON 字符串，最近若干条）。
   *
   * 这是**对照样本**：合成点击失败时，把它和"真人点一下时页面做的事"一比，
   * 就知道差在哪 —— 是接口不一样、参数少了，还是请求压根没发生。
   * 请求体里的 csrf 一律在页面侧就被遮蔽。
   */
  observations: string;
  /** 浏览器 UA。用来确认 Chrome 版本够不够新（`world: "MAIN"` 要 111+）。 */
  userAgent: string;
}

/** 一个直播间标签页的状态。键是内容脚本自己生成的 id。 */
interface TabState {
  /** 内容脚本生成的随机 id（每次页面加载换一个）。 */
  id: string;
  /** 页面地址。 */
  href: string;
  /** 页面标题。 */
  title: string;
  /** 页面上找到了输入框 / 发送按钮。 */
  hasInput: boolean;
  hasButton: boolean;
  /** 最近一次来轮询的时间。关掉的标签页靠它自然过期。 */
  lastSeenAt: number;
}

/** 桥的对外状态快照，供设置页显示。 */
export interface BridgeSnapshot {
  /** 桥是否在监听。 */
  listening: boolean;
  /** 实际监听的端口。 */
  port: number;
  /** 扩展最近一次来问是什么时候（毫秒时间戳）；从没来过是 0。 */
  lastSeenAt: number;
  /** 最近上报的页面状态（兼容字段；判断一律用 `tabs`）。 */
  page: BridgePageStatus | undefined;
  /**
   * 当前打开的直播间标签页。
   *
   * **长度本身就是信息**：1 个 = 直接发；多个 = 要么靠房间号挑，要么拒绝发送。
   * 设置页据此显示"打开了几个直播间"。
   */
  tabs: Array<{ id: string; href: string; title: string; ready: boolean }>;
  /** 最近一次发送失败的原因。 */
  lastError: string | undefined;
  /** 最近一次"拒绝派发"的原因（多个直播间但没有房间号时会用到）。 */
  refusal: string | undefined;
}

/** 桥的构造参数。 */
export interface BridgeOptions {
  /** 监听端口。0 表示让系统分配一个空闲端口（测试用）。 */
  port: number;
  /** 访问口令。空串时桥拒绝启动 —— 没有口令的桥等于把弹幕接口开放给本机所有程序。 */
  token: string;
}

/** 一条待发任务。 */
interface PendingTask {
  id: string;
  text: string;
  resolve: (result: { ok: boolean; code?: number; message?: string; target?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 这条任务**只发给这个标签页**。派发时就定好了，避免被别的直播间抢走。 */
  tabId: string;
  /** 目标直播间的地址，随成功回执一起给上层（用户要知道发到哪了）。 */
  targetLabel: string;
}

/**
 * 判定扩展是否"在线"。
 *
 * 轮询间隔是 800ms，所以 3 秒没动静就是真的断了（标签页被关、扩展被禁用、
 * 浏览器退出）。这个阈值直接决定设置页显示的状态，取太紧会闪。
 */
const OFFLINE_AFTER_MS = 3000;

/** 单条弹幕的等待上限。超时按失败处理，不能让状态机永远卡在"发送中"。 */
const DEFAULT_SEND_TIMEOUT_MS = 15000;

/** 请求体上限。我们只收几十字节的 JSON，给 64KB 已经很宽松。 */
const MAX_BODY_BYTES = 64 * 1024;

export class DanmakuBridge {
  private server: Server | undefined;

  /**
   * 待派发的任务队列。
   *
   * ⚠ **它和 `waiting` 必须分开**。第一版把它们合成了一个数组，于是任务被扩展
   * 取走（shift 出去）之后，回执回来时再也找不到它 —— 表现是**每一次发送都超时
   * 失败**，而日志上看起来一切正常（"已派发"、"已回执"两行都在）。
   * 这个 bug 是 test/bridge.test.mjs 抓出来的。
   */
  private readonly queue: PendingTask[] = [];

  /** 已派发、正在等回执的任务，按 id 索引。 */
  private readonly waiting = new Map<string, PendingTask>();

  private lastSeenAt = 0;
  private page: BridgePageStatus | undefined;
  private lastError: string | undefined;
  private token: string;

  /**
   * **按标签页**记录的状态。
   *
   * ## 为什么必须按标签页分开
   *
   * 用户可能同时开着好几个直播间页面。第一版只有一个全局的 `page` 字段
   * （"最后上报的那个赢"），于是：
   *
   *   * **不知道有几个直播间** —— 也就无法在"多个直播间但没配房间号"时拒绝发送；
   *   * 设置页的状态行会在几个直播间之间来回跳（谁刚上报就显示谁）；
   *   * 派发是"谁先轮询谁拿走"，弹幕会**随机落到其中一个直播间**。
   *
   * 键是内容脚本自己生成的随机 id（每次页面加载换一个），值是这个页面的状态。
   */
  private readonly tabs = new Map<string, TabState>();

  /**
   * 目标直播间号。空串表示"不限定"。
   *
   * 注意它**只在有多个直播间时才会被用来筛选** —— 只开了一个直播间时，
   * 用户填没填它都直接发（见 `planDispatch`）。这是刻意的：填房间号在多数
   * 场景下只是"顺手记一下"，不该因为它和地址对不上就拒绝发送。
   */
  private targetRoomId = '';

  /** 最近一次"拒绝派发"的原因，超时的错误信息用它。 */
  private refusal: string | undefined;

  /**
   * 盯着队首任务的目标标签页还在不在。
   *
   * 为什么需要它：任务在入队时就锁定了目标标签页，之后**只有那个标签页**
   * 能领走它。如果用户中途把它关掉了，任务就永远没人领 —— 而没有任何事件会
   * 触发我们检查这件事（剩下的标签页照样在轮询，但都不匹配）。
   * 结果就是用户干等 15 秒才收到一句含糊的"没有回执"。
   *
   * 所以用一个 1 秒的定时器主动看一眼：目标没了就**立即报错并说清原因**。
   */
  private targetWatch: ReturnType<typeof setInterval> | undefined;

  constructor(private options: BridgeOptions) {
    this.token = options.token;
  }

  /** 实际监听的端口；未启动时为 0。 */
  private actualPort = 0;

  /**
   * 启动监听。
   *
   * @param port - 覆盖构造时的端口。设置里改了端口就传新的进来。
   * @throws 端口被占用、或没配口令时抛错。**不静默降级**：桥没起来而界面显示
   *   "已启用"，是最难排查的状态。
   */
  async start(port?: number): Promise<number> {
    if (port !== undefined) this.options.port = port;
    if (this.server !== undefined) return this.actualPort;
    if (this.token.trim().length === 0) {
      throw new Error('本地桥没有口令，拒绝启动。请在设置里重新生成。');
    }

    const server = createServer((request, response) => {
      this.handle(request, response).catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        warn('本地桥处理请求失败:', reason);
        respondJson(response, 500, { error: reason });
      });
    });
    this.server = server;

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (cause: Error): void => {
        server.off('listening', onListening);
        reject(new Error(`本地桥无法监听端口 ${this.options.port}：${cause.message}`));
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolvePromise();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 只绑回环地址：这个端口不该被局域网里的任何人看到。
      server.listen(this.options.port, '127.0.0.1');
    });

    const address = server.address();
    this.actualPort = typeof address === 'object' && address !== null ? address.port : this.options.port;
    this.startTargetWatch();
    log(`本地桥已监听 127.0.0.1:${this.actualPort}（等待 Chrome 扩展连接）`);
    return this.actualPort;
  }

  /**
   * 每秒看一眼：队首任务的目标标签页还在不在。
   *
   * 没了就**立即失败**（原因见 `targetWatch` 的说明）—— 用户关掉标签页之后
   * 最多一两秒就会收到"目标页面不在了"，而不是干等 15 秒再拿到一句
   * 含糊的"没有回执"。
   */
  private startTargetWatch(): void {
    if (this.targetWatch !== undefined) return;
    const timer = setInterval(() => {
      if (this.queue.length === 0) return;
      const live = this.liveTabs();
      // 遍历而不是只看队首：队列通常只有一条，但没有理由让后面的任务漏检。
      for (const task of [...this.queue]) {
        if (live.some((tab) => tab.id === task.tabId)) continue;

        this.queue.splice(this.queue.indexOf(task), 1);
        clearTimeout(task.timer);
        const reason =
          `目标直播间页面已经不在了（${task.targetLabel}）—— 标签页被关掉了？` +
          '请重新打开它，或者改用一个还开着的直播间。';
        this.lastError = reason;
        warn('派发目标消失:', task.targetLabel);
        task.resolve({ ok: false, message: reason });
      }
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    this.targetWatch = timer;
  }

  /** 停止监听，并让所有在等的发送立刻失败（而不是等到超时）。 */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.actualPort = 0;
    if (this.targetWatch !== undefined) {
      clearInterval(this.targetWatch);
      this.targetWatch = undefined;
    }

    // 队列里的和已经在等回执的都要收掉 —— 后者更容易被忘掉，
    // 而它的调用方（状态机）会一直卡在"发送中"。
    const outstanding = [...this.queue, ...this.waiting.values()];
    this.queue.length = 0;
    this.waiting.clear();
    for (const task of outstanding) {
      clearTimeout(task.timer);
      task.resolve({ ok: false, message: '本地桥已停止' });
    }

    if (server === undefined) return;
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      // close() 只是停止接受新连接；这里没有长连接，所以不必强制销毁。
    });
  }

  /** 换口令（设置里改了）。下一次请求就用新的。 */
  setToken(token: string): void {
    this.token = token;
  }

  /** 换目标直播间号（设置里改了）。空串表示不限定。 */
  setTargetRoomId(roomId: string): void {
    this.targetRoomId = roomId.trim();
  }

  /** 当前状态快照。 */
  get snapshot(): BridgeSnapshot {
    // 每个标签页的状态都报出去 —— 设置页据此显示"打开了几个直播间"。
    const tabs = this.liveTabs().map((tab) => ({
      id: tab.id,
      href: tab.href,
      title: tab.title,
      ready: tab.hasInput && tab.hasButton
    }));
    return {
      listening: this.server !== undefined,
      port: this.actualPort,
      lastSeenAt: this.lastSeenAt,
      // `page` 保留成"最近上报的那个"，兼容旧字段；新的判断一律用 tabs。
      page: this.page,
      tabs,
      lastError: this.lastError,
      refusal: this.refusal
    };
  }

  /** 扩展在最近 `OFFLINE_AFTER_MS` 内来过吗。 */
  get extensionOnline(): boolean {
    if (this.lastSeenAt === 0) return false;
    return Date.now() - this.lastSeenAt < OFFLINE_AFTER_MS;
  }

  /**
   * 最近活跃的直播间标签页。
   *
   * 判据是"最近 `OFFLINE_AFTER_MS` 内来轮询过"：扩展每 800ms 来一次，
   * 所以关掉的标签页会在几秒内自然消失，不需要显式注销。
   */
  private liveTabs(): TabState[] {
    const now = Date.now();
    const result: TabState[] = [];
    for (const [id, tab] of this.tabs) {
      if (now - tab.lastSeenAt < OFFLINE_AFTER_MS) result.push({ ...tab, id });
    }
    return result;
  }

  /** 顺手清掉早就没动静的标签页，免得这个 Map 无限长大。 */
  private pruneTabs(): void {
    const now = Date.now();
    for (const [id, tab] of this.tabs) {
      // 留得比"活跃"窗口长得多：用户切走再切回来时，不希望它变成一个新标签页。
      if (now - tab.lastSeenAt > OFFLINE_AFTER_MS * 20) this.tabs.delete(id);
    }
  }

  /**
   * 决定这条任务该发给谁 —— 或者干脆不发。
   *
   * ## 三种情况（用户定的规则）
   *
   * | 打开的直播间 | 配了房间号 | 行为 |
   * |---|---|---|
   * | 只有一个 | 无所谓 | **直接发** —— 没有歧义，填没填房间号都不该拦 |
   * | 多个 | 配了 | 发给**匹配的那个**，并告诉用户发到了哪里 |
   * | 多个 | 没配 | **不发**，告诉用户去关掉多余的（否则只能靠猜，会发错房间） |
   *
   * 第二、三种的区别是刻意的：房间号在"只有一个直播间"时只是顺手记一下的字段，
   * 不该因为它和地址对不上就拒绝发送；而"多个直播间又没配房间号"时，
   * 我们**确实无法知道**该发到哪一个 —— 猜错就是把弹幕发进了别人的房间。
   */
  planDispatch(): { tabId: string } | { refuse: string } {
    const tabs = this.liveTabs();

    if (tabs.length === 0) {
      return { refuse: '没有直播间页面在轮询（标签页关掉了？）' };
    }

    // 只有一个：直接发，不看房间号。
    if (tabs.length === 1) return { tabId: (tabs[0] as TabState & { id: string }).id };

    // 多个：必须靠房间号挑出唯一的一个。
    const describe = tabs
      .map((tab) => tab.href.replace(/^https?:\/\/[^/]+/, ''))
      .join('、');

    if (this.targetRoomId.length === 0) {
      return {
        refuse:
          `检测到 ${tabs.length} 个直播间页面（${describe}）。` +
          '没有配置直播间号时无法确定发到哪一个，所以这次没有发送 —— ' +
          '请关掉多余的直播间，或者在设置里填上直播间号。'
      };
    }

    const matched = tabs.filter((tab) => roomIdOf(tab.href) === this.targetRoomId);
    if (matched.length === 0) {
      return {
        refuse:
          `打开的直播间里没有设置里那个（设置里是 ${this.targetRoomId}，` +
          `当前打开的是 ${describe}）。这次没有发送。` +
          '如果这其实是同一个直播间，请把设置里的房间号改成「地址栏里显示的那个」—— ' +
          'B 站会把短号跳转成真实房间号，两者不是同一个数字。'
      };
    }
    if (matched.length > 1) {
      // 用户明确要求：这种情况**拒绝**，而不是随便挑一个发。
      // 典型来源是"同一个直播间开了两个标签页"—— 发哪个其实都一样，
      // 但让他自己留一个更省心，也免得他以为发到别处去了。
      return {
        refuse: `有 ${matched.length} 个标签页都是这个直播间（${this.targetRoomId}）。` +
          '请只留一个，然后重试。'
      };
    }
    return { tabId: (matched[0] as TabState & { id: string }).id };
  }

  /**
   * 把一条弹幕交给扩展去发，并等它回执。
   *
   * 任务的派发方式是**拉取**：扩展下一次轮询时会取走它。所以这里不需要知道
   * 扩展在哪、也不需要维护连接 —— 这正是轮询方案最省心的地方。
   */
  async send(text: string, timeoutMs = DEFAULT_SEND_TIMEOUT_MS): Promise<{ ok: boolean; code?: number; message?: string; target?: string }> {
    if (this.server === undefined) {
      return { ok: false, message: '本地桥没有启动' };
    }
    // 从来没连上过：等下去没有意义，直接把原因说清楚。
    //
    // 但**"曾经连上、此刻恰好超过 3 秒"不在此列**：那可能只是 service worker
    // 刚被回收、下一次轮询还没到（最多 800ms 的窗口）。为它立刻报错会制造
    // 假故障 —— 用户看到"扩展没在轮询"，而 200 毫秒后它就上线了。
    // 所以这里只拦"一次都没来过"这一种确定的情况。
    if (this.lastSeenAt === 0) {
      return {
        ok: false,
        message: '扩展从来没有连接过。请确认 Chrome 里已加载扩展，并且打开着一个 B 站直播间页面。'
      };
    }

    // **能不能发、发给谁，现在就决定**。
    //
    // 不留给轮询那一刻判断，是因为"多个直播间又没配房间号"这种情况**注定发不出去**，
    // 让它等满 15 秒再报错毫无意义 —— 用户会盯着游戏等一个永远不会来的结果。
    // 立即拒绝并说清原因，他才能马上去关掉多余的标签页。
    const plan = this.planDispatch();
    if ('refuse' in plan) {
      this.refusal = plan.refuse;
      this.lastError = plan.refuse;
      return { ok: false, message: plan.refuse };
    }
    this.refusal = undefined;
    const targetTab = plan.tabId;

    // 目标标签页的信息，随成功回执一起给上层 —— 用户要知道"发到哪个直播间了"。
    const target = this.tabs.get(targetTab);
    const targetLabel = target === undefined ? '' : target.href;

    return new Promise((resolvePromise) => {
      const id = randomBytes(6).toString('hex');
      const timer = setTimeout(() => {
        this.forget(id);
        // 超时的原因分开写 —— 否则用户只能在"没反应"里猜。
        this.lastError = this.refusal !== undefined
          ? this.refusal
          : (this.extensionOnline
              ? '扩展没有在超时内回执'
              : '扩展在发送过程中掉线了（标签页被关掉，或扩展被禁用）');
        resolvePromise({ ok: false, message: this.lastError });
      }, timeoutMs);
      // 定时器不该拖住进程退出。
      if (typeof timer.unref === 'function') timer.unref();

      this.queue.push({ id, text, resolve: resolvePromise, timer, tabId: targetTab, targetLabel });
    });
  }

  /** 从两个容器里都摘掉一个任务（超时或收尾时用）。 */
  private forget(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) this.queue.splice(index, 1);
    this.waiting.delete(id);
  }

  // -------------------------------------------------------------------------
  // HTTP 处理
  // -------------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 扩展的请求来自 chrome-extension://<id>。把它记下来，供设置页判断在线。
    // 不做 Origin 白名单：扩展 id 在"加载已解压"模式下每个用户都不同，
    // 白名单没有可写的内容。门是口令，不是 Origin。
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('token') ?? '';
    if (!this.tokenMatches(token)) {
      respondJson(response, 403, { error: '口令不对' });
      return;
    }

    switch (`${request.method ?? 'GET'} ${url.pathname}`) {
      case 'GET /poll': {
        const tabId = url.searchParams.get('tab') ?? '';
        const href = url.searchParams.get('href') ?? '';
        this.markTab(tabId, href);
        this.lastSeenAt = Date.now();
        respondJson(response, 200, this.takeTask(tabId));
        return;
      }
      case 'GET /status':
        respondJson(response, 200, { ...this.snapshot, extensionOnline: this.extensionOnline });
        return;
      case 'POST /page': {
        const tabId = url.searchParams.get('tab') ?? '';
        const status = await readPageStatus(request);
        this.markTab(tabId, status.href, status);
        this.lastSeenAt = Date.now();
        this.page = status;
        respondJson(response, 200, { ok: true });
        return;
      }
      case 'POST /result':
        this.lastSeenAt = Date.now();
        this.acceptResult(await readJson(request));
        respondJson(response, 200, { ok: true });
        return;
      default:
        respondJson(response, 404, { error: '没有这个端点' });
    }
  }

  /**
   * 记下"某个标签页还在"。
   *
   * 没有 id 的请求（老版本扩展）会退化成一个固定的 id —— 那样多个直播间会被
   * 当成同一个，行为回落到第一版的"谁先轮询谁拿走"。总比直接不工作好。
   */
  private markTab(tabId: string, href: string, status?: BridgePageStatus): void {
    const id = tabId.length > 0 ? tabId : 'legacy';
    const previous = this.tabs.get(id);
    this.tabs.set(id, {
      id,
      href: href.length > 0 ? href : (previous?.href ?? ''),
      title: status?.title ?? previous?.title ?? '',
      hasInput: status?.hasInput ?? previous?.hasInput ?? false,
      hasButton: status?.hasButton ?? previous?.hasButton ?? false,
      lastSeenAt: Date.now()
    });
    this.pruneTabs();
  }

  /**
   * 取走最早的一条待发任务；没有就返回空对象。
   *
   * **任务在入队时就已经指定了目标标签页**（见 `planDispatch`），所以这里的
   * 判断很简单：不是给你的，就不给。这样即使开着好几个直播间，也不会出现
   * "谁先轮询谁抢走"—— 那会把弹幕发到别的房间去。
   *
   * @param tabId - 来领任务的标签页。
   */
  private takeTask(tabId: string): { id: string; text: string } | Record<string, never> {
    if (this.queue.length === 0) return {};

    const task = this.queue[0] as PendingTask;
    if (task.tabId !== (tabId.length > 0 ? tabId : 'legacy')) {
      // 队列是先进先出的，队首不是给它的就等下一轮 —— 不能跳过队首去取后面的，
      // 那会让弹幕的顺序乱掉。
      return {};
    }

    // 从队列移出、但**必须留在 waiting 里**：回执要靠 id 找回来。
    this.queue.shift();
    this.waiting.set(task.id, task);
    log(`本地桥派发弹幕给扩展：${task.text}`);
    return { id: task.id, text: task.text };
  }

  /** 扩展回执。 */
  private acceptResult(payload: Record<string, unknown>): void {
    const id = typeof payload.id === 'string' ? payload.id : '';
    const task = this.waiting.get(id);
    if (task === undefined) {
      // 超时之后才回来的回执。丢掉就好，但要记一笔 —— 它说明扩展比我们等得还慢。
      warn('收到一条没有对应任务的回执，已丢弃:', id);
      return;
    }

    this.waiting.delete(id);
    clearTimeout(task.timer);

    const ok = payload.ok === true;
    const code = typeof payload.code === 'number' ? payload.code : undefined;
    const message = typeof payload.message === 'string' ? payload.message : undefined;
    this.lastError = ok ? undefined : message ?? `扩展报告发送失败（code=${code ?? '?'}）`;
    // 目标地址一并回给上层：用户要知道这条发到哪个直播间了。
    task.resolve({ ok, code, message, target: task.targetLabel });
  }

  /**
   * 口令比对。
   *
   * 用 `timingSafeEqual` 而不是 `===`：后者会在第一个不同的字符处短路，
   * 理论上可以被逐字符猜（对本机端口来说这个威胁很小，但没有理由不写对）。
   * 长度不同时不能直接比 —— 那会抛异常，所以先比长度。
   */
  private tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(this.token, 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    if (expected.length === 0 || expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

/** 生成一个新的口令。 */
export function generateBridgeToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 取页面地址里的房间号。
 *
 * ## 为什么不能用 `href.includes(roomId)`
 *
 * 字符串包含会把 `roomId = "123"` 匹配到 `/12345` 上 —— 于是弹幕被发进
 * **别人的房间**。那是这个功能最不能出的错，所以改成解析出路径里的第一段、
 * 要求它**逐个数字相等**。
 *
 * 代价是"设置里填短号、页面显示真实房间号"时匹配不上（B 站会把短号跳转成
 * 真实号，两者不是同一个数字）。这种情况由调用方的错误文案引导用户改设置 ——
 * 那是他改一个字段就能解决的问题，而误发到别人房间不是。
 */
export function roomIdOf(href: string): string {
  try {
    const first = new URL(href).pathname.split('/').filter((part) => part.length > 0)[0] ?? '';
    return /^\d+$/.test(first) ? first : '';
  } catch {
    return '';
  }
}

/** 读取扩展上报的页面状态。缺字段一律按"没有"处理，不让畸形请求打断桥。 */
async function readPageStatus(request: IncomingMessage): Promise<BridgePageStatus> {
  const payload = await readJson(request);
  return {
    href: typeof payload.href === 'string' ? payload.href : '',
    title: typeof payload.title === 'string' ? payload.title : '',
    hasInput: payload.hasInput === true,
    hasButton: payload.hasButton === true,
    error: typeof payload.error === 'string' ? payload.error : '',
    hookReady: payload.hookReady === true,
    lastTrigger: typeof payload.lastTrigger === 'string' ? payload.lastTrigger : '',
    fillMode: typeof payload.fillMode === 'string' ? payload.fillMode : '',
    buttonDisabled: payload.buttonDisabled === true,
    inputElement: typeof payload.inputElement === 'string' ? payload.inputElement : '',
    buttonElement: typeof payload.buttonElement === 'string' ? payload.buttonElement : '',
    inputValue: typeof payload.inputValue === 'string' ? payload.inputValue : '',
    observations: typeof payload.observations === 'string' ? payload.observations : '',
    userAgent: typeof payload.userAgent === 'string' ? payload.userAgent : ''
  };
}

/** 读请求体并解析 JSON。超过上限就截断（我们只收很小的对象）。 */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) break;
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 统一出口。刻意**不发任何 CORS 头** —— 原因见文件头。 */
function respondJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(text);
}
