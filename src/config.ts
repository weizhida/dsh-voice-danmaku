/**
 * 设置命名空间 schema。
 *
 * 这是**用户能改的一切**的唯一定义处。字段上的 `.description()` 会被 DSH 的
 * 设置界面直接渲染成人话，所以它们不是注释、是 UI 文案，改的时候当心。
 *
 * 所有字段都有默认值：DSH 的设置层会先铺 schema 默认值、再叠用户的设置文档，
 * 所以插件内部拿到的永远是一个字段齐全的对象，不需要到处处理 undefined。
 */

import z from '@deepseek-ai/schemastery';

/** 设置命名空间。必须是全小写连字符形式，DSH 会校验。 */
export const SETTINGS_NAMESPACE = 'voice-danmaku';

// 枚举字段：用 `z.const` 的联合而不是 `z.union(['a','b'])`。
// 后者会把类型放宽成 `string`，而这些字段的值要参与 switch 的穷尽性检查，
// 类型一宽，加新通道时编译就不会报错——那正是我们想要它报错的地方。
const AsrEngineSchema = z.union([z.const('openai-compatible')]);
const AudioBackendSchema = z.union([z.const('ffmpeg')]);
const ChannelProviderSchema = z.union([z.const('page')]);

/**
 * 把一个 schema 字段标记为「可由设置表单热编辑」。
 *
 * ## 为什么不直接写 `.volatile()`
 *
 * `.volatile()` 是 `@deepseek-ai/schemastery` 从 **3.18.4** 起提供的方法，而本项目的
 * devDependency 钉的是 3.18.2 —— `tsc` 用的就是它那份类型定义，直接写会报
 * "Property 'volatile' does not exist"。
 *
 * 用接口增强（`declare module`）补这个方法的签名试过，但**会污染整条类型链**：
 * `provider` / `engine` 这类字段会退化成 `any`，连锁让 registry 里的穷尽性检查
 * （`const x: never = ...`）报错。所以改成在值层面绕过：这个 helper 的签名里
 * 泛型 `T` 原样进、原样出，类型不会丢，调用方看到的就是字段原本的类型。
 *
 * 运行时没有这个问题：插件的依赖由 DSH 宿主提供（见 package.json 的 peerDeps
 * 说明），宿主用的正是 3.18.4+，方法确实存在。等本地依赖升上去之后，这个
 * helper 可以直接删掉、换回 `.volatile()`。
 *
 * ## 为什么还要判一下这个方法在不在
 *
 * 本地 devDependency 停在 3.18.2，**连运行时也没有** `.volatile()` —— 单测和
 * `check-plugin.mjs` 用的就是这份，直接调会 `TypeError: schema.volatile is not
 * a function`。
 *
 * ## 而且这一条至关重要（一个真实故障）
 *
 * 插件是 `link:` 安装的，Node 解析 `@deepseek-ai/schemastery` 时会**先命中插件
 * 自己的 node_modules**（3.18.2），而不是宿主那份 3.18.4 —— 所以"直接调
 * volatile()"在**真机上也会失败**，标记从来没被写上。
 *
 * 后果不是报错，而是**静默的**：Host 侧 `dsh-settings` 的 `describe()` 用
 * `volatileForm(schema)` 过滤条目，一个 volatile 字段都没有的插件**根本不进设置
 * 镜像**；客户端于是找不到自己的命名空间，界面显示"设置服务当前不可用"。
 *
 * 所以这里必须有第二条路：`extra('volatile', true)` 写的是同一份 meta ——
 * `volatileForm()` 检查的就是这个标记，等价。
 */
const vol = <T>(schema: T): T => {
  const s = schema as unknown as {
    volatile?: () => T;
    extra?: (key: string, value: unknown) => T;
  };
  // 首选正式方法（3.18.4+）。
  if (typeof s.volatile === 'function') return s.volatile();
  // 3.18.2 的兜底：实测 extra('volatile', true) 之后 toJSON() 里就是
  // "volatile":true，与 volatile() 的产物一致。
  if (typeof s.extra === 'function') return s.extra('volatile', true);
  return schema;
};

/** 按键配置。 */
const KeysConfig = z.object({
  /** 开始/停止录音。 */
  record: vol(z.string().default('F9'))
    .description('开始/停止录音的按键。游戏里按住说话，再按一次结束。'),
  /** 确认并发送。 */
  send: vol(z.string().default('F11'))
    .description('把浮层上的识别结果发送出去的按键。'),
  /** 取消当前文本。纯取消 —— 超长截断在识别完成时就做完了，不占用这个键。 */
  cancel: vol(z.string().default('F10'))
    .description('取消本次识别结果的按键。')
});

/**
 * 媒体键配置。
 *
 * ## 为什么需要第二套按键
 *
 * 普通键盘按键靠低级键盘钩子（`WH_KEYBOARD_LL`）捕获，而**带反作弊的游戏会让
 * 这个钩子完全失效**：实测 CFHD + ACE 下，钩子、Raw Input、`GetAsyncKeyState`
 * 轮询、乃至 G HUB 转发的 F13 全部收不到任何按键，而它们在游戏外都正常。
 *
 * 媒体键不一样：它们走 HID **Consumer Control**（用途页 0x0C），而不是键盘的
 * 0x06 用途页，由系统用 `RegisterHotKey` 派发。所以它是目前唯一已知能穿过去的
 * 通道。代价是：
 *
 *   * 媒体键是**共享资源**（音乐播放器、系统音量也在用），所以不能吞键，
 *     且默认**关闭**——不主动去抢本来属于别人的键；
 *   * `RegisterHotKey` 只派发按下、没有抬起，所以按住说话是不可靠的，
 *     这里的交互必须是"按一下切换"。
 *
 * 这三项与普通按键**同时生效**：游戏外用 F9/F10/F11，游戏里用媒体键，互不冲突。
 */
const MediaKeysConfig = z.object({
  /**
   * 总开关。默认关闭。
   *
   * 默认关的理由：注册媒体键会与其它程序抢键（尤其"下一曲"常被音乐播放器
   * 占用），而绝大多数场景下普通按键已经够用。只有确实要在带反作弊的游戏里
   * 用的人才需要打开。
   */
  enabled: vol(z.boolean().default(false))
    .description(
      '是否启用媒体键（音量、上一曲、播放暂停等）。' +
      '只有在游戏里普通按键完全没反应（反作弊拦截键盘钩子）时才需要打开。'
    ),
  /** 开始/停止录音。按一下开始，再按一下结束。 */
  record: vol(z.string().default('AudioVolumeMute'))
    .description(
      '媒体键：按一下开始录音，再按一下结束并识别。' +
      '推荐用「静音」键。直接填键名（如 AudioVolumeMute、MediaPlayPause、' +
      'MediaTrackNext）或键码都行。'
    ),
  /** 确认并发送。 */
  send: vol(z.string().default('MediaTrackNext'))
    .description('媒体键：确认并发送识别结果。推荐用「下一曲」键。'),
  /** 取消。 */
  cancel: vol(z.string().default('MediaPlayPause'))
    .description('媒体键：取消本次识别结果。推荐用「播放/暂停」键。')
});

/** 浮层外观与行为。 */
const OverlayConfig = z.object({
  /** 出现时是否显示。关掉就只剩声音提示，适合不想被挡视线的人。 */
  enabled: vol(z.boolean().default(true))
    .description('是否显示浮层。关闭后仅靠声音反馈，屏幕上不会出现任何东西。'),
  /** 正文字号（像素）。 */
  fontSize: vol(z.number().min(10).max(96).step(1).default(26))
    .description('浮层正文字号（像素）。'),
  /** 内边距。 */
  padding: vol(z.number().min(4).max(80).step(1).default(18))
    .description('浮层内边距（像素）。'),
  /** 距屏幕上边缘的距离。 */
  marginTop: vol(z.number().min(0).max(2000).step(1).default(0))
    .description('浮层距屏幕上边缘的距离（像素）。0 表示贴顶。'),
  /** 不透明度百分比。 */
  opacity: vol(z.number().min(20).max(100).step(1).default(88))
    .description('浮层不透明度（百分比）。'),
  /** 水平锚点：0 贴左、50 居中、100 贴右。 */
  anchorXPercent: vol(z.number().min(0).max(100).step(1).default(50))
    .description('浮层水平位置：0 贴左、50 居中、100 贴右。'),
  /** 最大宽度占屏幕比例。 */
  maxWidthPercent: vol(z.number().min(20).max(100).step(1).default(80))
    .description('浮层最大宽度占屏幕宽度的百分比。'),
  /** 点击是否穿透到游戏。 */
  clickThrough: vol(z.boolean().default(true))
    .description('点击是否穿透到游戏。开启后浮层完全不接收鼠标，绝不会误挡操作。'),
  /** 是否允许拖动浮层。 */
  draggable: vol(z.boolean().default(true))
    .description('是否允许按住浮层把它拖到别处。拖动时会临时关闭点击穿透。'),
  /** 重申置顶的间隔；有些游戏会把置顶窗口挤下去。 */
  reassertSeconds: vol(z.number().min(1).max(30).step(1).default(2))
    .description('每隔几秒重申一次浮层置顶。某些游戏会把它挤到下面，调小更稳。')
});

/** 识别服务（OpenAI 兼容的转写接口）。 */
const AsrConfig = z.object({
  /** 引擎选择。留成枚举是为了后面加本地离线识别。 */
  engine: AsrEngineSchema.default('openai-compatible')
    .description('语音识别引擎。'),
  /** 转写接口地址。 */
  baseUrl: vol(z.string().default('https://api.siliconflow.cn/v1'))
    .description('转写服务的 API 地址（OpenAI 兼容）。默认硅基流动。'),
  /**
   * 模型名。默认 **Qwen/Qwen3-ASR-1.7B**。
   *
   * 实测延迟对比（2 秒音频，同一台机器）：
   *   Qwen/Qwen3-ASR-1.7B            0.37s   收费（更快、更准）
   *   XingChenASR-V3.2-Ultra         ——      免费，未实测（列表里的备选）
   *   XingChenASR-V3.2               0.65s   免费，但**识别率明显偏低**：实测多次把
   *                                          正常的中文短句识别成完全无关的内容
   *   FunAudioLLM/SenseVoiceSmall    13–66s  ← 慢到不可用，不要选
   *
   * 设置界面给了一个候选下拉框（候选名单见下面的 `modelOptions`）方便点选，
   * 但**不限制**你填别的 —— 服务商随时会上新模型，用户不该为了用它来等插件更新。
   *
   * 改这里**不需要重启**：模型名是每次识别时现读的。
   */
  model: vol(z.string().default('Qwen/Qwen3-ASR-1.7B'))
    .description(
      '转写模型名。默认 Qwen/Qwen3-ASR-1.7B（约 0.4 秒，识别率好）。' +
      '想用免费的有 XingChenAGI/XingChenASR-V3.2-Ultra 和 XingChenAGI/XingChenASR-V3.2 可选。' +
      '注意 FunAudioLLM/SenseVoiceSmall 在本服务上极慢（十几秒到一分钟），不要用。' +
      '改这里立即生效，不需要重启。'
    ),
  /**
   * 模型下拉框里的候选项。
   *
   * ## 为什么它是配置而不是写死在界面代码里
   *
   * **别人的常用模型和你的不一样**，而服务商上新的速度很快。写死在界面里意味着
   * 用户想加一个模型得改代码、重新构建 —— 那对"给自己用的工具"还能忍，对
   * 要发出去的插件不合适。
   *
   * ## 它只影响界面
   *
   * 下拉框里有哪些选项，仅此而已。**真正决定用哪个模型的是 `model`** ——
   * 你把 `model` 填成任何一个字符串都生效，哪怕它不在这份候选里。
   *
   * 界面上刻意**不给**它输入框：它是"配置文件的配置"，想加就自己往里加一行。
   */
  modelOptions: vol(z.array(z.string()).default([
    'Qwen/Qwen3-ASR-1.7B',
    'XingChenAGI/XingChenASR-V3.2-Ultra',
    'XingChenAGI/XingChenASR-V3.2'
  ])).description('设置界面里模型下拉框的候选项。只影响界面，不影响识别。想加模型就在这里加一行。'),
  /** 密钥。用 secret 角色声明，设置界面只显示"已设置/未设置"，不会回显值。 */
  apiKey: vol(z.string().role('secret').default(''))
    .description('转写服务的 API 密钥。只保存在本机，不会被插件外的任何东西读取。'),
  /** 识别语言。 */
  language: vol(z.string().default('zh'))
    .description('识别语言代码，如 zh、en。留空则自动判断。'),
  /** 单次识别超时。 */
  timeoutMs: vol(z.number().min(1000).max(120000).step(1000).default(20000))
    .description('单次转写的超时时间（毫秒）。')
});

/** 录音采集。 */
const AudioConfig = z.object({
  /**
   * 采集后端。目前只实现了 ffmpeg —— Node 没有内置的麦克风采集能力，
   * 详见 src/audio.ts 顶部的说明。
   */
  backend: AudioBackendSchema.default('ffmpeg')
    .description('录音采集后端。当前实现基于 ffmpeg。'),
  /**
   * ffmpeg 可执行文件位置。**默认留空 = 自动探测**。
   *
   * 第一版这里默认是 `'ffmpeg'`（靠 PATH 解析），等于要求用户知道它装在哪。
   * 实际上绝大多数人不知道，所以改成留空触发自动探测：会依次查 PATH、
   * winget/scoop/choco 的安装位置、以及常见的解压目录。详见 src/ffmpeg.ts。
   */
  ffmpegPath: vol(z.string().default(''))
    .description(
      'ffmpeg 位置。**留空即自动探测**（依次查 PATH、winget/scoop/choco 安装位置、' +
      '常见解压目录），多数情况下不需要填。只有自动探测失败、或想指定特定版本时才填完整路径。'
    ),
  /**
   * 录音设备名。**默认留空 = 自动选第一个**。
   *
   * dshow 采集器要求设备名与 `ffmpeg -list_devices` 报出的**逐字一致**，
   * 而且不接受 `default` 这种写法——所以这里默认自动枚举，避免让用户去猜。
   * 有多支麦克风、或想指定某个特定设备时才填。
   */
  device: vol(z.string().default(''))
    .description(
      '录音设备名。**留空即自动选第一个可用麦克风**。' +
      '如果自动选的不是你想要的（比如选了耳麦而不是独立麦克风），' +
      '把设备名填在这里，名字要与系统里显示的一致。'
    )
});

/** 页面注入通道（浏览器扩展）的连接参数。 */
const PageChannelConfig = z.object({
  /**
   * 本地桥的监听端口。
   *
   * 桥只绑回环地址（127.0.0.1），扩展也在这台机器上，所以端口号本身不是秘密。
   * 之所以可配：默认端口可能被你机器上别的程序占用。
   */
  port: vol(z.number().min(1024).max(65535).step(1).default(39217))
    .description('本地桥端口。扩展选项里要填同一个值。除非被占用，否则不用改。'),
  /**
   * 本地桥口令。
   *
   * ⚠ 这里刻意**不用 secret 角色**：secret 字段在设置界面里不回显，而用户必须
   * 能看见它、把它复制到扩展的选项页去。它的敏感度也远低于登录凭证 —— 桥只
   * 监听回环地址，外部网络够不着，泄露它的前提是攻击者已经能在你机器上执行代码。
   */
  token: vol(z.string().default(''))
    .description('本地桥口令。留空会自动生成；把它复制到扩展选项页里（两边必须一致）。'),
  /**
   * 桥与扩展的联通状态。由宿主自动维护，设置页据此告诉我们"到底卡在哪一环"。
   *
   * 为什么需要它：页面通道有**四段**可能断掉的链路（桥没起 → 扩展没连 →
   * 页面没就绪 → 桥和扩展的口令不一致），而它们在用户眼里是同一个现象：
   * "按了没反应"。这个字段把四段压缩成一个可显示的结论。
   */
  status: z.string().default('')
    .description('本地桥连接状态。由宿主自动维护，不需要手改。')
});

/** 弹幕发送通道。 */
const ChannelConfig = z.object({
  /**
   * 通道选择。
   *
   * 现在只有一条：**让浏览器页面自己去发**。插件里不存任何凭证，签名由页面
   * 保证正确，代价是直播间标签页得开着。
   *
   * 字段本身保留成枚举而不是写死，是因为它将来还会有第二个值 —— 加通道时要改的
   * 只有这里加一个 `z.const`、registry 里加一个分支，别处都不用动。
   *
   * ## 被删掉的那一条：插件自己发 HTTP 请求
   *
   * 它曾经存在，靠用户粘贴的整行 Cookie 发请求。删掉有两个理由：
   *   1. **它已经不可用了**：页面通道的观测抓到真实浏览器请求带了 `w_rid`
   *      wbi 签名，而那条实现没有这个参数 —— 服务端大概率直接拒绝；
   *   2. 它是**唯一**需要把登录凭证存进插件的地方。少一条这样的路径，
   *      就少一份"凭证泄露"的风险面。
   */
  provider: ChannelProviderSchema.default('page')
    .description('弹幕怎么发出去。目前只有页面发送一种：由 Chrome 里打开的直播间页面发出。'),
  /** 直播间号（短号或真实房间号）。 */
  roomId: vol(z.string().default(''))
    .description(
      'B 站直播间号，就是你直播间地址里那串数字。' +
      '留空表示"任意直播间页面都行"；填了则会校验你打开的那个页面是不是它。'
    ),
  /** 页面注入通道的连接参数。 */
  page: PageChannelConfig,
  /**
   * 弹幕长度上限。**可配**，默认 20。
   *
   * ## 为什么它是个设置而不是常量
   *
   * B 站各处的上限并不统一（不同房间、不同账号等级都可能不一样），而**真正的
   * 裁决权在服务端**。所以这个值只决定"我们截到多长"：超了照样发，被服务端
   * 拒绝时会给出明确理由 —— 那比我们在本地猜一个数字可靠得多。
   *
   * 判据是 `String.length`（UTF-16 码元）：汉字 1、英文数字 1、emoji 2。
   * 它和 B 站前端的算法未必一致，但它是**用户自己能核对**的那一种。
   */
  maxLength: vol(z.number().min(20).max(100).step(1).default(20))
    .description(
      '弹幕长度上限（字数）。默认 20。**超过会自动截断再发送**，并告诉你截断了 —— ' +
      '能不能发出去最终由 B 站判定，这里只是避免白送一条必然被拒的长弹幕。'
    ),
  /** 发送最小间隔。防手滑与防意外连发。 */
  minIntervalMs: vol(z.number().min(1000).max(60000).step(500).default(4000))
    .description('两条弹幕之间的最小间隔（毫秒）。低于此值的发送会被直接拒绝。两条通道共用这一条。'),
  /** 每小时发送上限，保险丝。 */
  maxPerHour: vol(z.number().min(1).max(600).step(1).default(20))
    .description('每小时最多发送多少条。这是防止意外连发的保险丝，不是风控参数。两条通道共用这一条。')
});

/** 行为与反馈。 */
const BehaviorConfig = z.object({
  /**
   * 是否随 DSH 启动。
   *
   * 为什么做成开关：sidecar 是个常驻进程，还会装全局键钩子、在托盘留图标。
   * 有些用户只在需要时才想让它跑（比如不直播的时候），所以必须能关掉，
   * 并且在设置页手动启动。关掉后托盘图标也不会出现。
   */
  autoStart: vol(z.boolean().default(true))
    .description(
      '是否随 DSH 自动启动。关闭后不会自动运行，也不会出现托盘图标；' +
      '需要时在下面点「启动」按钮。'
    ),
  /**
   * 手动启动口令。
   *
   * 实现说明：设置页的按钮无法直接调用宿主方法（那要走 remote 命名空间，
   * 对一个"启动/停止"动作来说太重）。所以按钮改为**往这个字段写一个新值**，
   * 宿主监听设置变化，看到值变了就执行启动。用一个单调递增的整数而不是
   * 布尔值，是为了让"连续点两次"也能各自触发一次。
   */
  launchToken: vol(z.number().default(0))
    .description('手动启动口令。由设置页的按钮递增，不需要手改。'),
  /**
   * 哪些密钥**已经填过**。由宿主侧计算后回写，供设置页显示"已保存"的遮罩。
   *
   * ## 为什么需要这个字段（而不是直接用 DSH 的 secret 标记）
   *
   * DSH 的描述符里每个 secret 槽位带一个 `set` 标记，看起来正是为这个用途设计的。
   * 但实测它**不可用**：`describe()` 内部是
   *     redactSecrets(schema, registration.resolved)
   * 而 walk 里判断 `set: value !== void 0`。密钥字段的 schema 默认值是空字符串，
   * 于是 `'' !== undefined` 恒为真 —— **每个密钥都报"已设置"**，无法区分
   * "填过" 与 "还是默认空值"。
   *
   * 所以改由宿主自己判断（它拿得到真实值），把结论写进这个**非密钥**字段，
   * 设置页直接读它。字段名以 `x` 结尾是刻意的：它明显是派生状态，
   * 不该被当成用户配置项。
   */
  secretStatus: z.array(z.string()).default([])
    .description('已填写的密钥字段路径。由宿主自动维护，不需要手改。'),
  /**
   * 媒体键的注册结果。由宿主侧回写，供设置页显示"哪个键没抢到"。
   *
   * 为什么必须回写而不是只写日志：`RegisterHotKey` 会因为键被别的程序占用而
   * **静默失败**，表现为"按这个键毫无反应"。用户无法从任何界面看出是配置不对、
   * 还是被占用了，而这个字段能直接说清楚。
   */
  mediaKeysReport: z.string().default('')
    .description('媒体键注册结果。由宿主自动维护，不需要手改。'),
  /** 是否吞掉热键，让游戏收不到。 */
  consumeKeys: vol(z.boolean().default(true))
    .description('热键是否对游戏隐藏。开启后游戏完全收不到这几个键。'),
  /** 确认窗口的自动取消时间。 */
  confirmTimeoutSeconds: vol(z.number().min(0).max(120).step(1).default(8))
    .description('浮层出现后多久没操作就自动取消（秒）。0 表示不自动取消。'),
  /**
   * 是否用声音反馈。**默认关闭。**
   *
   * 曾经默认开着，理由是"眼睛盯着游戏时听觉比视觉可靠"。实测下来这个理由不成立：
   * 提示音是系统默认音频设备上 90 毫秒的短音，戴耳机打游戏时会被游戏声音完全
   * 盖住 —— 用户的原话是"我也没听到过提示音"。而浮层本身已经足够显眼。
   *
   * 代码和开关都保留：换成音箱、或哪天又想要听觉反馈，勾一下就能用。
   */
  soundFeedback: vol(z.boolean().default(false))
    .description('是否用提示音反馈状态。默认关闭 —— 游戏声音通常会把它盖住，浮层已经够用。'),
  /** 识别成功后是否自动发送，跳过人工确认。默认关闭。 */
  autoSendOnRecognized: vol(z.boolean().default(false))
    .description('识别完成后直接发送，不等待确认。默认关闭——误发的代价比多按一次键高。')
});

/** 完整的设置 schema。 */
export const Config = z.object({
  keys: KeysConfig,
  mediaKeys: MediaKeysConfig,
  overlay: OverlayConfig,
  audio: AudioConfig,
  asr: AsrConfig,
  channel: ChannelConfig,
  behavior: BehaviorConfig
});

/** 解析后的设置值。字段全部有默认值，因此不存在 undefined。 */
export type VoiceDanmakuConfig = ReturnType<typeof Config>;
