# 参与开发

感谢你有兴趣。这个项目有几条**刻意为之**的约定，先看完再动手能省不少来回。

## 环境

```sh
npm install            # 只装开发依赖（typescript + @types/node）
npm run build:all      # 编译 TypeScript 插件 + C# 原生层
npm test               # 全部校验（每层做什么见 README 的表格）
```

需要 Windows（原生层是 Windows 专属）。**不需要** .NET SDK —— sidecar 用
Windows 自带的 `csc.exe` 编译，见 `docs/architecture.md` 的说明。

## 提交前必须做的事

```sh
npm test
```

全绿再提 PR。CI 会跑同样的检查；类型检查那一层在 CI 上会跳过（裸 runner 没有
DSH 安装，而所需类型定义不在 npm 上），所以**类型问题只能靠你本地发现**——
别跳过本地的 `npm test`。

`npm test` 里有一层是 `test:secrets`：它按 `.gitignore` 划出**会进仓库的文件**，
再扫本机路径里的用户名、真实直播间号、密钥字面量、B 站凭证这些东西。测试里请
一律用假值（`C:\Users\u\…`、房间号 `12345`、口令 `test-token-…`）。它报错时不要
急着往白名单里加东西 —— 先确认那个值真的是假的。

## 代码约定

### 注释写"为什么"，不写"是什么"

这个项目的注释密度明显高于平均水平，是刻意的：很多代码在这里存在，是因为
"显而易见的做法会在某个具体场景下出错"。删掉那段注释，下一个人就会把它改回去。

比如：

```ts
// 复用时用配置签名而不是对象引用：设置服务每次 get() 都可能返回新对象，
// 靠引用判断会导致每次都重建，而限流状态就存在被重建的那个对象上。
```

不要写这种：

```ts
// 设置通道
channel.set(x)
```

### 纯逻辑必须可测

`src/machine.ts` 和 `src/wiring.ts` 刻意不碰 I/O，所有外部能力通过参数注入。
新增业务逻辑时请沿用这个形状——能用假依赖测完的逻辑，不要写成需要真实
麦克风/网络才能验证的样子。

### 长生命周期对象的复用/重建要单独测

`wiring.ts` 单独存在，是因为开发中出现过这样一个 bug：状态机每次发送都调用
`createChannel()` 新建通道实例，而**频率限制的状态存在通道对象上** —— 每次 new 就等于
把限流清零，最小间隔和每小时上限双双失效。

阴险的地方在于：通道自己的单元测试全绿，因为那些测试是直接构造一个实例、连发两次来
测限流的。错的不是组件，是**创建组件的方式**。

所以"什么时候复用、什么时候重建"被抽到 `wiring.ts` 并单独测试
（`test/wiring.test.mjs` 断言的是**实例身份**，不是返回值内容）。

### 跨进程契约是唯一的接口

本项目有**两条**跨进程契约，各自是一份文档：

| 契约 | 两端 | 文档 |
|---|---|---|
| sidecar 协议 | 插件 ↔ C# 原生进程（stdio 上的 JSON Lines） | `docs/protocol.md` |
| 本地桥协议 | 插件 ↔ Chrome 扩展（回环地址上的 HTTP） | `docs/bridge.md` |

新增能力时：

1. 先在对应文档里写清楚消息与字段；
2. 再改两侧的实现（原生层是 `sidecar/src/Program.cs` 与 `src/sidecar-client.ts`；
   扩展是 `extension/` 与 `src/bridge.ts`）；
3. 给 `tools/harness.mjs` 或 `test/` 加一个能验证它的路径。

不要让业务概念（"录音""弹幕"）泄漏到协议里——原生层只认"显示文字""订阅键位"，
扩展只认"把这段文字填进去并点发送"。

### 扩展的权限只能收窄，不能放宽

`extension/manifest.json` 里的权限是**用户决定装不装这个扩展的唯一依据**。
它现在只有 `storage` + `http://127.0.0.1/*`，内容脚本只注入
`https://live.bilibili.com/*`。

`npm run test:extension` 会守着这条线：任何人加上 `<all_urls>`、外部域名的
host 权限、或者 `tabs` / `cookies` 这类权限，CI 立刻变红。要放宽必须有明确的
理由，并且写进 README 让用户知道。

**原生层的失败必须回报，不能只写日志。** 这条是硬约定：`RegisterHotKey`、
`SetWindowsHookEx` 这类调用失败时系统不会告诉你，表现是"按了没反应"。
所以每个可能失败的原生操作都要在回执里留一个字段（如 `mediaKeysReport`、
`ready.hookInstalled`），让用户在设置页上就能看到原因。详见 `docs/protocol.md`
的"媒体键"一节。

### 键名必须在三处保持一致

`src/keys.ts` 的名字表、`sidecar/src/Program.cs` 的 `KeyNames`、
以及浏览器 `KeyboardEvent.key` 的规范名（如 `MediaPlayPause`）。
设置页的「按一下媒体键」按钮把 `event.key` **原样**写进配置，三处不一致就会
存下一个永远解析不出的字符串。`test/keys.test.mjs` 用"键码 → 名字 → 键码"
的往返不变量钉住这件事。

### 新增 provider

弹幕通道与识别引擎都是可替换的 provider。步骤见
`docs/architecture.md` 的"可扩展点"。**漏注册会编译报错**（枚举收敛成 `never`），
这是故意的：加新平台时你一定会被提醒。

### 风控与合规不能绕过

`src/channels/` 下的任何实现都必须自己执行频率限制（最小间隔 + 每小时上限）。
这不是"可选的健壮性"，而是防止插件变成刷屏机、导致用户账号被风控的唯一保险丝。
**不要**为了"测试方便"而提供绕过路径。

## 测试放哪

| 你改了什么 | 应该加什么测试 |
|---|---|
| `src/machine.ts` 的状态迁移 | `test/machine.test.mjs` |
| `src/keys.ts` 的键名/键码解析 | `test/keys.test.mjs`（含往返不变量） |
| 装配、复用/重建决策 | `test/wiring.test.mjs` |
| 插件入口契约、设置 schema、跨字段校验 | `tools/check-plugin.mjs` |
| 设置的注册/覆盖/校验 | `tools/check-settings.mjs` |
| 设置页的渲染与文案 | `tools/check-client.mjs` |
| 跨进程协议、原生层行为（含媒体键注册） | `tools/harness.mjs` |
| **配置 → sidecar 注册 → 回执回写**这条链路 | `tools/check-media-report.mjs` |
| 本地桥（派发、回执、口令、页面过滤） | `test/bridge.test.mjs` |
| 桥**什么时候被拉起来**、用什么口令、状态怎么回写 | `tools/check-page-bridge.mjs` |
| 页面发送通道的每一条分支 | `test/page-channel.test.mjs` |
| Chrome 扩展（清单、语法、**权限**） | `tools/check-extension.mjs` |
| 热键链路 | `tools/harness.mjs` 的 inject 模式 |
| 文档里的路径/文件名/脚本名 | `tools/check-docs.mjs`（改文档后跑一次） |
| **不该公开的东西**（本机用户名、真实直播间号、密钥） | `tools/check-secrets.mjs`（改测试/文档后顺手跑一次） |

### 每一层在验证什么

`npm test` 会依次跑下面这些。分这么多层不是为了数字好看，而是因为**它们抓的是不同
种类的错**：静态检查抓字段名漂移，假上下文的契约检查抓入口形状，真服务的集成检查抓
"字段回写错了但功能照常"这种静默失败。

| 命令 | 验证什么 | 用什么验证 |
|---|---|---|
| `npm run typecheck` | 全部源码对 **DSH 真实类型定义**类型正确 | `tsc --noEmit` |
| `npm run test:docs` | 文档里提到的路径、文件名、npm 脚本都真实存在 | 把文档与磁盘对照（纯静态） |
| `npm run test:extension` | 扩展的 manifest、语法、**权限最小化**（不得申请全站访问） | 解析 manifest + 编译每个脚本 |
| `npm run test:mask` | **遮罩归属**：圆点必须出现在"已设置"的那个密钥字段上 | 用真实组件渲染两种 `secretStatus` |
| `npm run test:secrets` | 不该公开的东西有没有混进来 | 按 `.gitignore` 划出待提交的文件逐条扫 |
| `npm run test:client` | 设置页真渲染、文案 key 齐全、契约（不读明文密钥、媒体键捕获、候选来自配置） | 手写的模块加载器 + `react-dom/server` |
| `npm run test:unit` | 状态机、限流闸门、键码往返、装配决策、**本地桥与页面通道** | `node:test`（桥会真的监听端口） |
| `npm run test:hotkey` | **钩子安装 → 订阅 → 键码解析 → 事件穿过管道** | 用 Win32 `keybd_event` 合成真实按键 |
| `npm run test:plugin` | 入口契约、设置 schema 默认值、**跨字段校验**、卸载清理 | 假 cordis 上下文跑真实的 `apply` |
| `npm run test:media` | **媒体键从配置到注册的整条链路**（含回执回写到设置） | **真插件 + 真 `SettingsProvider` + 真 sidecar** |
| `npm run test:page` | **本地桥跟着通道起停、口令自动生成、状态上报** | **真插件 + 真 `SettingsProvider`**（桥真的监听端口） |
| `npm run test:restart` | **sidecar 被杀掉后能自动恢复**（否则插件会变成静默僵尸） | 真的杀掉进程，看它是否自己回来 |
| `npm run test:settings` | 注册、用户层覆盖、变更广播、**校验真的拦住写入**、secret 不回显 | **DSH 真实的 `SettingsProvider`**（仅存储换内存替身） |
| `npm run test:smoke` | 浮层置顶、**不抢焦点**、**媒体键注册与注销**、无孤儿进程 | 直接驱动 sidecar exe |

几条容易踩的：

- `test:unit` 用了 `--experimental-test-isolation=none`：默认的"每个文件一个子进程"在
  某些受限环境下会被拦（`spawn EPERM`），同进程运行没有这个依赖；
- `test:hotkey` 合成一次按键。这是**注入**而非真实硬件输入，所以它验证协议与分发链路，
  不验证"某个游戏是否放行钩子"；
- `test:media` 存在的理由是另一类静默失败：配置填了、sidecar 也正常，但某一环（字段没
  下发、回执接错字段）断了，现象全是"按了没反应"。它跑的是**真插件 + 真设置服务 +
  真 sidecar**，并断言设置里真的出现了注册回执；
- 两条**必须真人**的验证不在 `npm test` 里，因为它们要切进游戏按键：
  `npm run verify:hotkey`（普通按键）与 `npm run verify:media`（媒体键）。

### 派生字段（宿主回写的那种）一定要有端到端测试

`behavior.secretStatus`、`behavior.mediaKeysReport` 这类字段有个共同点：
**它们错了完全静默** —— 功能照常、日志照常，只是设置页上少一行显示。
静态检查抓不住（代码看起来完全正确），假上下文也抓不住（假 scope 不会拒绝写入）。

所以这类字段的测试必须用**真插件 + 真设置服务 + 真 sidecar**，
断言"设置里真的出现了那个值"。现成的模板见 `tools/check-media-report.mjs`。

它抓到过一个真实的 bug：`syncMediaReport(applied.mediaKeys)` 少写了一个
`Report`，于是回写进设置的是 `173,176,179`（键码表）而不是
`ok=AudioVolumeMute,…`（回执），设置页那行状态永远不出现。

## 关于"看起来在干活"

请不要为了增加测试数量而写重复断言。这个仓库的测试密度已经覆盖到
"能在没有真人、没有游戏、没有凭证的情况下验证的一切"。剩下的几件事
（真实游戏是否放行**媒体键**、浮层在真实游戏上的可见性、真实 ASR、真实弹幕发送）
**本质上无法自动化**，README 里已如实标注。往那个方向堆测试只会制造虚假信心。

（"真实游戏是否放行**普通按键**"已经不是待验证项了 —— 实测证实不放行，
这条结论本身推动了媒体键那条通道的实现。）

## 提交信息

用中文或英文都可以，但要说清**为什么**改：

```
修复：sidecar 退出后插件永久静默失效

原因：machine 被置空后所有按键都走进空操作，用户看到的是"按什么都没反应"。
改法：加自动重启主管（指数退避 + 上限），并补一条真的杀进程的验证。
```

## License

提交即表示你同意以 MIT 许可发布你的贡献。
