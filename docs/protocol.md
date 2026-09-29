# sidecar 协议（JSON Lines over stdio）

> 这是本项目**唯一的跨进程契约**。主程序（Node/DSH 插件）和 sidecar（Windows 原生 exe）
> 之间只通过它通信。读懂这一页，就能在不碰对方代码的前提下替换任意一侧。

## 为什么是这个形状

sidecar 只做两件 Node 做不好的事：**全局键盘钩子**和**置顶且不抢焦点的浮层**。
ASR、B 站、配置、状态机全在主程序里。所以协议刻意做得很小：

- **一行一条消息，UTF-8 JSON 对象**，`\n` 分隔。没有长度前缀、没有分帧、没有握手协商。
- **只有标量字段**（字符串/数字/布尔/null）。没有嵌套对象、没有数组——
  需要传列表时用逗号分隔的字符串（如 `keys: "120,121,119"`）。
- **入站消息必须有 `type`**；带 `id` 的消息会收到带同一个 `id` 的回执，便于请求-应答配对。
- 未知 `type` 不致命：回一条 `error` 继续跑。一条坏消息不能打死常驻进程。

解析器只实现了上述子集（`sidecar/src/Program.cs` 里的 `Json`）。这是刻意的：
契约越小，两侧越不容易在"我以为你会发什么"上产生分歧。

## 主程序 → sidecar

### `configure` — 应用配置

幂等，可随时重发；sidecar 不会重启，只更新内部状态。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | — | 回执配对用 |
| `keys` | string | — | 要订阅的虚拟键码，逗号分隔（`"120,121,122"` = F9,F10,F11）。走键盘钩子 |
| `mediaKeys` | string | `""` | 要注册的**媒体键**虚拟键码，逗号分隔（`"173,179,176"`）。走 `RegisterHotKey`，见下方"媒体键"一节。空串表示一个都不注册 |
| `consumeKeys` | bool | `true` | 是否**吞掉** `keys` 里的键，让游戏收不到。见下方"已知边界"。媒体键**永远不吞** |
| `fontSize` | int | `26` | 浮层正文字号（像素），钳制在 10–96 |
| `padding` | int | `18` | 浮层内边距，钳制在 4–80 |
| `marginTop` | int | `0` | 浮层距屏幕上边缘的距离 |
| `opacity` | int | `88` | 浮层不透明度百分比，钳制在 20–100 |
| `anchorXPercent` | int | `50` | 水平锚点百分比（0=贴左，50=居中，100=贴右） |
| `maxWidthPercent` | int | `80` | 浮层最大宽度占屏幕宽度的百分比 |
| `reassertSeconds` | int | `2` | 每隔几秒重申一次顶层位置 |
| `clickThrough` | bool | `true` | 点击是否穿透到游戏。开启时浮层完全不接收鼠标 |
| `draggable` | bool | `true` | 是否允许按住浮层拖动（拖动期间会临时关闭穿透） |

回执：`configured`，带回实际生效的 `watched`（键码）与 `labels`（键名）。

### `show` — 显示浮层

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | — | 回执配对用 |
| `text` | string | `""` | 要显示的主文本 |
| `accent` | string | 上次的值 | 左侧色条颜色，`#RRGGBB` |
| `hint` | string | `""` | 次要提示行（如"F10 发送 · F11 取消"） |
| `showHint` | bool | `true` | 是否显示 `hint` |
| `state` | string | `"shown"` | 状态标签。除了原样回传，**还用于驱动托盘图标配色**，见下 |

回执：`shown`，包含关键诊断字段（见下）。

#### `state` 的取值约定

`state` 是给主程序（和调试用的人）看的语义标签：`recording`、`transcribing`、
`confirm`、`sending`、`sent`、`error`、`shown`。

它**不影响托盘图标**。托盘图标刻意不做状态变色 —— 曾经做过，但两套状态名在主程序与
浮层之间对不上，实际永远显示灰色；而用户也不需要它（识别状态由浮层显示，那才是
用户看的地方）。托盘只回答一个问题："它在不在跑"。

### `hide` — 隐藏浮层

幂等。回执：`state`。

### `verify` — 自检浮层的真实物理状态

用于回答"浮层真的压在游戏上面吗"这个否则只能靠肉眼判断的问题。
**它不做任何假设，只回报观测到的事实。**

### `ping` — 存活探测，回执 `pong`

### `shutdown` — 优雅退出，回执 `bye` 后进程结束

## sidecar → 主程序

| `type` | 时机 | 关键字段 |
|---|---|---|
| `ready` | 启动完成 | `pid`、`hookInstalled`、`hookError`、`x64` |
| `configured` | 收到 `configure` | `watched`、`labels`、`mediaKeys`、`mediaKeysReport`、`consumeKeys`，以及钳制后的外观值 |
| `shown` | 收到 `show` | 见下方诊断字段 |
| `state` | 浮层隐藏 | `state` |
| `key` | **捕获到按键** | `vk`、`key`（键名）、`source`（`hook`/`media`）、`phase`（`down`/`up`）、`heldMs`、`foreground` |
| `verification` | 收到 `verify` | 见下方 |
| `moved` | 用户拖动浮层结束 | `x`、`y`（主程序据此持久化位置） |
| `pong` | 收到 `ping` | `uptimeMs` |
| `error` | 消息无法处理 | `message` |
| `bye` | 即将退出 | `reason`、`intentional` |

### `source` 为什么必须报出来

同一个键码可能同时出现在 `keys` 和 `mediaKeys` 里（用户可以把 F9 也填进媒体键）。
主程序按 `source` 查**不同的动作表**，否则一次按键会触发两个动作 —— 而"哪个生效"
取决于遍历顺序，表现为"有时候发送、有时候取消"这种几乎无法复现的问题。

### `heldMs` 与媒体键的交互约束

`RegisterHotKey` **只派发按下、没有抬起**，所以 sidecar 用 20ms 定时器轮询
`GetAsyncKeyState` 自己量出"按住了多久"，抬起时通过 `heldMs` 一并上报。
`down` 事件的 `heldMs` 恒为 0。

由此产生一条硬约束：**媒体键不能用"按住说话"**（按下时还不知道用户会按住多久），
只能用"按一下开始、再按一下结束"的切换式交互。这是设计选择，不是没做。

### 媒体键：唯一已知能穿过反作弊的通道

普通按键走低级键盘钩子（`WH_KEYBOARD_LL`）。带内核级反作弊的游戏（实测 CFHD +
ACE/TP）会让这个钩子**完全收不到任何按键** —— 钩子、Raw Input、`GetAsyncKeyState`
轮询、乃至驱动软件（G HUB）转发的 F13 全部失效，而它们在游戏外都正常。

媒体键（音量、上一曲、播放暂停…）走的是 HID **Consumer Control**（用途页 `0x0C`），
而不是键盘的 `0x06` 用途页，由系统用 `RegisterHotKey` 派发。这使它成为目前唯一
已知能穿过去的通道。代价有三条，都体现在协议里：

1. **不吞键。** 媒体键是共享资源（音乐播放器、系统音量都在用），sidecar 对
   `mediaKeys` 永远不调用 `consumeKeys` 的逻辑。
2. **没有抬起事件**，因此只能切换式交互（见上）。
3. **注册可能失败。** 别的程序（常见：音乐播放器占着"下一曲"）已经注册过同一个键时
   `RegisterHotKey` 返回失败，而且是**静默**的。所以回执里必须有 `mediaKeysReport`：

   | 取值 | 含义 |
   |---|---|
   | `ok=AudioVolumeMute,MediaPlayPause` | 这些注册成功了 |
   | `ok=… failed=MediaTrackNext` | `failed=` 后面的没注册上（键被占用） |
   | `ok=` | 一个都没注册（`mediaKeys` 为空，即未启用） |

   失败时 sidecar 的日志里另有一行带 Win32 错误码的细节。客户端只显示键名 ——
   `err 1409` 对用户没有意义（它几乎总是"已被占用"）。

   主程序收到回执后会把它**回写进设置**（`behavior.mediaKeysReport`），设置页据此
   显示"已注册 / 未注册"。回写时 `ok=` 会被归一成空串、不落盘 —— 那是"没有信息"，
   不是"注册结果为空"，否则用户文档里会多一个恒为 `ok=` 的键。

   > 这条回写链路单独有一个测试（`tools/check-media-report.mjs`）：它错了完全静默，
   > 静态检查和假上下文都抓不住，只有"真插件 + 真设置服务 + 真 sidecar"能证明
   > 设置里真的出现了那个值。

### `shown` 与 `verification` 的诊断字段

这两个消息是**可验证性设计**的核心：把"看起来应该在上面"变成可读的数字。

| 字段 | 含义 |
|---|---|
| `overlayHwnd` | 浮层窗口句柄 |
| `rect` | 浮层矩形 `left,top,width,height`（屏幕坐标） |
| `topMost` | 1 表示窗口带置顶样式 |
| `foregroundBefore` / `foregroundAfter` | 显示浮层**前后**的前台窗口句柄 |
| `focusKept` | 两者相等。**这是"没抢焦点"最硬的证据** |
| `withinScreen` | 浮层是否完全落在显示器范围内 |
| `selfAtCenter` | 浮层中心点上的最顶层窗口是不是浮层自己 |
| `occluded` | `no` / `skipped-transparent` / `yes`，见下 |
| `foreground` | 当前前台窗口的 `进程名 \| 标题` |

**关于 `occluded`**：`WindowFromPoint` 会跳过带 `WS_EX_TRANSPARENT` 的窗口。
因此当 `clickThrough` 开启（浮层点击穿透）时，中心点上的窗口**本来就不是浮层**，
这是预期行为而非遮挡。协议把两种原因分开报告，避免自检给出误导性结论：

- `no` —— 中心点就是浮层，没被挡。
- `skipped-transparent` —— 因为点击穿透被命中测试跳过，属正常。
- `yes` —— 真被别的窗口挡住了，这时才需要处理。

## 生命周期：谁在什么时候拉起 sidecar

sidecar **不是**随 DSH 无条件启动的。控制权在用户手上：

| 触发 | 行为 |
|---|---|
| DSH 启动，`behavior.autoStart = true` | 自动拉起 |
| DSH 启动，`behavior.autoStart = false` | **不启动**。不装全局钩子、不留托盘图标 |
| 用户在设置页点「启动」 | 拉起（同时把 `autoStart` 置为 true） |
| sidecar 崩溃 | 自动重启（指数退避，最多 5 次） |
| 用户从托盘点「退出」 | 退出，**且不自动重启** |

### 为什么"手动启动"走设置字段而不是远程调用

设置页的按钮无法直接调用宿主方法 —— 那需要注册一个 remote 命名空间，
对一个"启停一个进程"的动作来说太重了。所以改成：

1. 按钮把 `behavior.launchToken` **递增 1**（单调计数器，不是布尔值 ——
   这样连续点两次能各自触发一次）；
2. 宿主监听设置变化，发现 `launchToken` 变了就拉起 sidecar。

宿主用 `lastLaunchToken` 初值 `-1` 表示"尚未观察过"，因此**第一次读到设置只建立
基线、不触发启动**。少了这一步，"插件读自己的设置"这个动作本身就会拉起 sidecar，
开关就失去意义了。

### 退出为什么要区分"谁要求的"

`bye` 消息带一个 `intentional` 字段：

- `true` —— 用户从托盘点的退出。主程序**不重启**。
- 缺省 / `false` —— 崩溃或外部结束。主程序按自愈逻辑重启。

这个区分是必需的：没有它，用户点"退出"→ 进程结束 → 主程序判定为崩溃 →
立刻拉起来，表现为**"点了退出它又自己冒出来，根本关不掉"**（实测踩到过）。

### 托盘图标只做一件事

托盘图标**不做状态变色**。曾经做过（录音变红、识别变琥珀…），但两套状态名在
主程序与浮层之间对不上，实际永远显示灰色；而用户也不需要它 —— 识别状态由浮层
负责显示，那才是用户看的地方。

托盘图标要回答的问题只有一个：**"它在不在跑"**，再加一个能真正退出的入口。

## 已知边界与失败模式

**1. `consumeKeys` 不一定能拦住所有游戏。**
低级键盘钩子（`WH_KEYBOARD_LL`）在绝大多数游戏里有效，但少数使用内核级输入
（Raw Input / 内核反作弊）的游戏可能既收不到我们的钩子，也拦不住按键。
判定方法：跑 `node tools/harness.mjs watch`，按一次 F9——
如果终端打印出 `key` 事件，说明捕获成功。

**在这类游戏里改用媒体键**（`mediaKeys`，见上文）。它走的是另一条上报通道，
代价是不能吞键、只能切换式交互。

**2. 钩子回调有超时。**
Windows 对 `WH_KEYBOARD_LL` 回调有超时限制（注册表 `LowLevelHooksTimeout`，
通常 300ms），超时会**静默**把钩子从链上摘掉，表现为"按了没反应"且没有任何提示。
所以回调里只做查表和发消息，任何耗时工作都必须交给主程序。
如果你发现长时间运行后热键突然失灵，这是首要怀疑对象。

**3. 独占全屏（exclusive fullscreen）下置顶窗口可能仍然被覆盖。**
Windows 的全屏优化会让独占全屏游戏绕过 DWM 合成。无边框窗口化（borderless
windowed）不受影响。如果你的游戏是独占全屏，请在游戏里切换为无边框窗口化。

**4. 高 DPI。**
sidecar 启动时调用 `SetProcessDPIAware()`。多显示器且缩放比例不一致时，
浮层坐标以物理像素为准。

## 手工调试

不必启动 DSH 就能和 sidecar 对话：

```sh
# 逐条输入 JSON 看回执
node tools/harness.mjs raw
{"type":"ping","id":"1"}
{"type":"show","id":"2","text":"你好","hint":"F10 发送"}
{"type":"verify","id":"3"}
```

sidecar 自己的诊断日志写在
`%TEMP%\dsh-voice-danmaku\sidecar-<pid>.log`，
`harness.mjs` 每次运行结束都会自动打印最近一份的尾部。
