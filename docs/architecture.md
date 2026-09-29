# 架构

## 一句话

**业务逻辑全在 Node 插件里，只有"Node 干不了的两件事"下沉到 Windows 原生 sidecar。**

```
┌─────────────────────────────────────────────────────────────────────┐
│  DSH 宿主进程 (Node)                                                 │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ dsh-voice-danmaku 插件                                        │  │
│  │                                                               │  │
│  │  settings ──► 配置解析/校验                                    │  │
│  │  hotkey   ──► 状态机 (idle/recording/recognizing/confirm/…)    │  │
│  │  asr      ──► 语音转文字            (可替换 provider)          │  │
│  │  channel  ──► 把文字发到直播间      (可替换 provider)          │  │
│  │  bridge   ──► 本地桥：给页面通道用（只监听 127.0.0.1）          │  │
│  │  overlay  ──► 浮层控制薄封装                                   │  │
│  │  sidecar  ──► 子进程生命周期 + 协议客户端                       │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ JSON Lines over stdio
                               │ (docs/protocol.md)
┌──────────────────────────────▼──────────────────────────────────────┐
│  sidecar 进程 (C#, .NET Framework, 单文件 exe)                       │
│                                                                     │
│  KeyboardHook   ── WH_KEYBOARD_LL 全局钩子，只查表+上报             │
│  MediaKeyWatcher── RegisterHotKey 注册媒体键（穿反作弊的那条通道）   │
│  OverlayForm    ── 置顶 / 不抢焦点 / 点击穿透 的浮层                 │
│  Json + Protocol── 极小的 JSON Lines 编解码                          │
│                                                                     │
│  它不认识 B 站、不认识 ASR、不认识 DSH。                             │
└─────────────────────────────────────────────────────────────────────┘

        ┌─────────────────────────────────────────────────────┐
        │ Chrome 扩展「语音弹幕桥」（extension/）              │
        │  content.js  ── 找输入框、填字、点发送               │
        │  page-hook.js── 包住页面自己的 fetch，读回执          │
        │  background.js─ 唯一发网络请求的地方                  │
        └───────────────────────┬─────────────────────────────┘
                                │ HTTP（轮询）/ 只监听 127.0.0.1
                                │ (docs/bridge.md)
                        ┌───────▼────────┐
                        │  本地桥        │  ← 插件里的一个极小 HTTP 服务
                        └────────────────┘
```

## 为什么要有 sidecar

不是"想用 C#" ，而是有两个能力在 Node 里做不到或代价很高：

| 能力 | 为什么必须在原生层 |
|---|---|
| 全局低级键盘钩子 | 需要 `SetWindowsHookEx(WH_KEYBOARD_LL)` + 消息循环。纯 JS 要装 FFI 原生模块，而且钩子回调运行在安装它的线程上，必须有一个消息泵 |
| 媒体键（`RegisterHotKey`） | 带内核级反作弊的游戏会让键盘钩子完全收不到按键，而媒体键走 HID Consumer Control 的另一条上报通道，由系统派发。它需要一个窗口句柄接收 `WM_HOTKEY`，所以必须和消息循环在一起 |
| 置顶且不抢焦点的浮层 | 需要 `WS_EX_TOPMOST` + `WS_EX_NOACTIVATE` + `WS_EX_TRANSPARENT` 组合。浏览器窗口做不到（后台标签页会被全屏游戏压下去），单独开浏览器窗口也抢焦点 |

**把这些隔离在一个只讲小协议的进程里，换来三个好处：**

1. **可验证**：`tools/harness.mjs` 能脱离 DSH 直接测 sidecar，
   协议回执里带 `focusKept`、`occluded` 这类客观数字，不靠"我觉得它显示出来了"。
2. **可替换**：以后若要省掉子进程，可以写一个用 `koffi` 直接调 Win32 的
   实现，只要它说同样的协议，业务层一行都不用改。
3. **崩溃隔离**：原生层出问题不会拖垮 DSH 宿主。

## 为什么用 .NET Framework 的 csc，而不是 .NET SDK

Windows 自带 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，
而 .NET SDK 需要用户额外安装。

- **收益**：终端用户零安装成本；产物是单文件 exe，仓库里不放二进制。
- **代价**：只能用 .NET Framework 的 API（`langversion:5`）。
  对本项目完全够用——我们只用到 WinForms、Win32 P/Invoke 和基础 BCL。
- **坑（已处理）**：csc 默认按系统 ANSI 代码页读源码。本项目源码是 UTF-8
  且含中文字面量，所以 `build.mjs` 里必须传 `/codepage:65001`，
  否则编译出来的中文全是乱码。

## 可扩展点

### 新增一个录音后端

Node 没有内置的麦克风采集能力，这是**整个项目里唯一一处"当前实现依赖外部程序"的地方**。
现状与出路：

| 方案 | 状态 | 权衡 |
|---|---|---|
| 外部 `ffmpeg`（当前实现） | ✅ 已实现 | 零编译、零额外二进制、行为可预测；代价是用户需要装 ffmpeg |
| Windows 原生采集（waveIn / WASAPI） | ⬜ 计划中 | 完全无外部依赖；代价是要在 sidecar 里多写一块采集逻辑并处理设备枚举 |
| 原生 Node 模块（naudiodon 等） | ⬜ 备选 | 使用体验最好；代价是要求用户有编译工具链 |

要换成原生采集：实现 `AudioRecorder` 接口（`src/audio.ts`），在 `createRecorder`
的注册表里登记，并给 `config.audio.backend` 的联合加上新值。
业务层只认接口，不认识 ffmpeg。

### 新增一个弹幕通道（provider）

发送层刻意做成接口，因为"往哪发"是最可能变的部分（B 站 HTTP 接口、
页面内注入、其他平台……）。要加一个通道：

1. 在 `src/channels/` 下新建一个模块，实现同一个接口：

```ts
export interface DanmakuChannel {
  /** 通道标识，出现在日志与设置里。 */
  readonly id: string;
  /** 发送前自检配置是否齐全，返回人类可读的问题描述。 */
  check(): Promise<string[]>;
  /** 发送一条弹幕。返回结果而不是抛异常——失败是常态，要可呈现。 */
  send(text: string): Promise<SendResult>;
}
```

`SendResult.unsure` 是这套接口里最要紧的一个字段：**"可能发出去了"必须和"确定没发
出去"分开表达**。前者要求用户自己去直播间看一眼，后者可以安全地再试一次 —— 把两者
混成一个 `ok: false`，用户就会在结果未知时重按，然后直播间里出现两条。

2. 在 `src/channels/registry.ts` 的 `switch` 里登记。
   漏了会**编译报错**：枚举收敛成 `never`，这正是我们想要的强制。
3. 在 `src/config.ts` 里给 `channel.provider` 的联合加上新 id。
   必须用 `z.const`（不是 `z.string`），否则穷尽性检查会失效。

**约束（请务必遵守）**：发送实现必须自己执行频率限制
（最小间隔 + 每小时上限），不要依赖调用方。风控风险属于通道实现的责任范围——
不同平台的上限完全不同，放在状态机里既不知道平台的规矩，也没法按平台调整。

### 新增一个 ASR 引擎

同理，`src/asr/` 下实现接口并在 `registry.ts` 登记。预期至少两种：

- **云端 OpenAI 兼容转写**（如硅基流动 SenseVoice）—— ✅ 已实现，配置简单、精度好。
- **本地离线**（sherpa-onnx）—— ⬜ 计划中，零密钥、不受网络影响，代价是要下模型。

### 新增一个热键

热键不是硬编码的。配置里是"虚拟键码逗号分隔"，sidecar 只订阅这一组键，
主程序按 `vk → 动作` 的表去分发。加一个键 = 改配置 + 在动作表里加一项。

**两套键、两条通道**：`keys` 走键盘钩子（能吞键，游戏外通用），
`mediaKeys` 走 `RegisterHotKey`（不能吞键，但能穿反作弊）。sidecar 在
`key` 事件里用 `source` 标明来源，主程序据此查**不同的**动作表 ——
同一个键码可以同时出现在两边而互不干扰。加通道时的规矩：

- 新通道必须在协议里带上自己的 `source`，否则两个动作会抢一次按键；
- 新通道的失败必须是**可见**的（`mediaKeysReport` 就是为此存在），
  原生层静默失败是"按了没反应"这类问题的根源；
- 名字要在三处保持一致：`src/keys.ts`、`sidecar/src/Program.cs` 的 `KeyNames`、
  以及浏览器的 `KeyboardEvent.key`（设置页的捕获按钮直接写它）。

## 状态机

热键驱动的状态迁移。**任何时刻只允许一个待确认文本**，
新的一次录制总是取代上一次——半途而废的识别结果不应该堆在屏幕上。

```
        F9                      F9                    识别完成
idle ─────────► recording ─────────► recognizing ─────────► confirm
  ▲                 │                      │                    │
  │                 │ F11 取消             │ 失败               │ F10 发送
  │                 ▼                      ▼                    ▼
  └────────────── cancel ◄─────────────────┘                 sending
                                                               │
                                                               ▼
                                                        sent / failed
```

- `recording` 期间浮层显示"正在听"（可选，见设置）。
- `confirm` 期间超过 `confirmTimeoutSeconds` 无操作则自动取消：
  游戏里手一忙就会忘记它还挂着，不自动收尾迟早会误发。
- 长度上限是 `channel.maxLength`（默认 20，可设 20–100）。
  超长时**在识别完成的那一刻就自动截断**，浮层告知"已截断到 N 字"，
  然后照常发送。截掉的内容不再回显——显示一段注定发不出去的文字没有意义。
  真正的裁决权留给服务端：本地算出来的长度和 B 站的不一定一致（表情、
  全角、emoji 都算字符的方式不同），所以本地只做保守处理，不替服务端拒绝。

## 目录结构

```
src/
  index.ts            插件入口：定义 name/inject/Config，装配各模块
  config.ts           设置命名空间 schema、默认值、校验
  keys.ts             虚拟键码 <-> 名称（含媒体键名），按键动作表
  logger.ts           带前缀的日志
  machine.ts          状态机（纯逻辑，可单测）
  audio.ts            ffmpeg 录音采集
  ffmpeg.ts           探测 ffmpeg 位置
  bridge.ts           本地桥：页面通道与 Chrome 扩展之间的 HTTP 服务
  wiring.ts           长生命周期对象的复用/重建决策（通道限流状态不能丢）
  sidecar-client.ts   sidecar 子进程生命周期 + 协议收发 + 自动重启
  sidecar-path.ts     定位 exe（开发态/安装态）
  asr/
    types.ts          AsrEngine 接口
    http-openai.ts    OpenAI 兼容转写实现
    registry.ts       按配置选引擎
  channels/
    types.ts          DanmakuChannel 接口
    rate-limit.ts     发送闸门（限流 + 并发互斥）
    text.ts           弹幕文本的清洗（去尾部标点、折叠空白）
    bilibili-codes.ts 服务端拒绝码 -> 人话（扩展从页面请求里 hook 回来的）
    page.ts           交给你浏览器里打开的直播间页面去发（当前唯一的通道）
    registry.ts       按配置选通道
extension/            Chrome 扩展（页面通道的另一端）
  manifest.json       MV3 清单（权限只到 bilibili 直播间 + 回环地址）
  page-hook.js        MAIN world：包住页面自己的 fetch/XHR，读 /msg/send 的回执
  content.js          ISOLATED world：找输入框、填字、点发送
  background.js       service worker：唯一发网络请求的地方
  popup.html/js       填桥的端口与口令
sidecar/
  src/Program.cs      Windows 原生层（键盘钩子 + 媒体键 + 浮层 + 协议）
  src/TrayIcon.cs     托盘图标（"它在不在跑"的唯一常驻标志 + 退出入口）
  build.mjs          用 csc 编译成单文件 exe
tools/
  harness.mjs         脱离 DSH 的协议驱动器 / 冒烟测试 / 热键与媒体键验证
  check-extension.mjs 扩展的静态检查（含权限最小化守卫）
  check-secrets.mjs   敏感信息入库守卫（本机用户名、真实直播间号、密钥字面量）
docs/
  architecture.md     本文件
  protocol.md         sidecar 协议契约
  bridge.md           本地桥协议契约（插件 ↔ Chrome 扩展）
```

**分层原则**：`machine.ts` 不碰 I/O，所以它可以纯逻辑单测；
所有 I/O（子进程、HTTP、音频）都在被注入的依赖里，测试时替换掉。
