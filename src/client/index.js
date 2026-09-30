/**
 * dsh-voice-danmaku —— 浏览器半区（设置页面）
 * ============================================================================
 * 这个文件是**手写的客户端 bundle**，格式必须符合 DSH 运行时模块加载器：
 *
 *     window.__ModuleLoader__.load({ id, factory })
 *
 * 为什么手写而不是用打包器：官方包用 tsdown 打包，会把 React 等一起内联进去。
 * 但 `factory` 里拿到的 `require` 本来就能解析 `react` 与 `@deepseek-ai/*` ——
 * 那些东西加载器已经准备好了（官方 bundle 也正是这样 `require` 它们的）。
 * 所以对本插件这种规模，手写反而更少依赖、更好审计：你一眼能看完它做了什么。
 *
 * 代价：不能用 JSX，要写 `react.createElement`；也没有 CSS Modules，
 * 样式用内联对象（颜色走 DSH 的 CSS 变量，自动跟随明暗主题）。
 *
 * ## 为什么需要这个文件
 *
 * 宿主侧插件用 `ctx.settings.register()` 注册了设置命名空间，但 DSH 的设置
 * 界面是**客户端渲染**的：左侧导航的每一页都由一个客户端插件通过
 * `ctx.slots.register()` 往 `settings.section` 插槽里注册。宿主侧注册命名空间
 * 只让值可读写，不会自己长出界面。所以在补上这一半之前，设置里看不到任何东西。
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-danmaku',

  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');

    /** 设置命名空间，必须与宿主侧 src/config.ts 的 SETTINGS_NAMESPACE 一致。 */
    var NAMESPACE = 'voice-danmaku';

    /**
     * 界面文案，中英各一份，**扁平点号键**。
     *
     * 扁平形式不是风格选择，而是必须的：组件里查字段标签用的是
     * `t('fields.' + 'keys.record')`，拼出来就是 `fields.keys.record`。
     * 如果字典写成嵌套的 `{ fields: { 'keys.record': ... } }`，就查不到了 ——
     * 这个 bug 真发生过一次，被 tools/check-client.mjs 的"渲染结果里不含
     * 原始文案 key"断言抓住。官方插件用的也是扁平键。
     *
     * 中英必须成对：locale 服务在当前语言缺 key 时会去查 FALLBACK_LOCALE='en'。
     */
    var STRINGS = {
      zh: {
        nav: '语音弹幕',
        intro: '在游戏里用语音发直播间弹幕。按键、浮层、识别与发送通道都在这里配置。',
        hintUnavailable: '设置服务当前不可用，无法读写配置。',
        hintMemory: '当前设置只保存在这个浏览器进程里，不会写入宿主配置文件。',
        hintSaveHint: '改动需要点「保存」才写入。密钥类字段留空表示不修改。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        'field.custom': '自定义…',
        secretPlaceholder: '尚未设置。粘贴后点「保存」',
        // 填过的字段被点开编辑时，提示必须换一句。
        // 原来两种情况共用"尚未设置"，用户点了已填写的字段会以为自己的密钥丢了
        // （这是实测反馈的原话："我再点击就显示成尚未设置了"）。
        secretKeep: '已填写过。留空表示保持不变',
        secretClear: '清除',
        secretClearConfirm: '确定清除这个已保存的密钥吗？清除后需要重新填写。',

        'document.open': '打开配置文件',
        'document.opening': '打开中…',
        'document.hint': '直接编辑 settings.yaml（改动会热加载）',
        'document.unavailable': '当前环境不支持打开配置文件',
        'document.failed': '打开失败',

        'control.title': '运行状态',
        'control.hint': '关闭「随 DSH 启动」后本插件不会自动运行，右下角也不会出现托盘图标。需要时点「启动」。',
        'control.start': '启动',
        'control.starting': '启动中…',
        'control.autoStart': '随 DSH 启动',

        'groups.keys': '按键',
        'groups.mediaKeys': '媒体键',
        'groups.overlay': '浮层',
        'groups.audio': '录音',
        'groups.asr': '识别服务',
        'groups.channel': '发送通道',
        'groups.behavior': '行为',

        'fields.keys.record': '录音键',
        'fields.keys.send': '发送键',
        'fields.keys.cancel': '取消键',
        'fields.mediaKeys.enabled': '启用媒体键',
        'fields.mediaKeys.record': '录音（切换）',
        'fields.mediaKeys.send': '发送',
        'fields.mediaKeys.cancel': '取消',
        'mediaKeys.hint': '游戏里普通按键没反应时（反作弊拦截了键盘钩子），改用媒体键。按一下开始录音，再按一下结束并识别——RegisterHotKey 没有抬起事件，所以这里必须用"按一下切换"而不是按住说话。媒体键会被其它程序共享，所以不会被吞掉。',
        'mediaKeys.timeout': '没等到媒体键。可以直接在框里手填键名（如 MediaTrackNext）或键码。',
        'mediaKeys.disabledWarning': '⚠ 媒体键还没启用 —— 上面这个开关是总闸，不打开的话，下面填了也不会生效。点「按一下媒体键」会自动打开它。',
        'mediaKeys.pending': '已启用，但还没收到注册结果（sidecar 可能没在运行，或正在重启）。',
        'mediaKeys.reportTitle': '媒体键注册结果：',
        'mediaKeys.reportOk': '已注册：',
        'mediaKeys.reportFailed': '未注册：',
        'mediaKeys.reportFailHint': '（多半已被其它程序占用，换一个键，或先关掉占用它的程序）',
        'mediaKeys.listSep': '、',
        'fields.overlay.enabled': '显示浮层',
        'fields.overlay.fontSize': '字号',
        'fields.overlay.marginTop': '距屏幕上边缘',
        'fields.overlay.opacity': '不透明度',
        'fields.overlay.anchorXPercent': '水平位置',
        'fields.overlay.clickThrough': '点击穿透到游戏',
        'fields.overlay.draggable': '允许拖动',
        'fields.audio.ffmpegPath': 'ffmpeg 位置',
        'fields.audio.device': '录音设备',
        'fields.asr.baseUrl': 'API 地址',
        'fields.asr.model': '模型',
        'fields.asr.apiKey': 'API 密钥',
        'fields.asr.language': '识别语言',
        'fields.channel.roomId': '直播间号',
        'fields.channel.maxLength': '弹幕长度上限',
        'fields.channel.page.port': '本地桥端口',
        'fields.channel.page.token': '本地桥口令',
        'fields.channel.minIntervalMs': '发送最小间隔',
        'fields.channel.maxPerHour': '每小时上限',

        'channel.page.hint': '弹幕由 Chrome 里打开的直播间页面发出：插件把文字交给一个扩展，由扩展填进输入框并点击发送。请求由页面自己发出，所以插件里不需要保存任何凭证。需要先在 Chrome 里加载本项目的 extension/ 目录，并把下面的口令填进扩展弹窗。',
        'channel.status.down': '⚠ 本地桥没有启动。上面端口那里应该有报错，也可以换一个端口再保存。',
        'channel.status.waiting': '⚠ 桥在等着，但扩展还没连上来。请确认：① Chrome 扩展已加载并启用；② 打开着一个 B 站直播间页面；③ 扩展弹窗里的端口和口令与这里一致。',
        'channel.status.not-ready': '⚠ 扩展连上了，但那个页面里没找到弹幕输入框或发送按钮。确认那个标签页确实是直播间页面、并且已经登录。',
        'channel.status.page-error': '⚠ 扩展连上了，但在页面上操作时出错了（多半是 B 站改版导致找不到元素）。先在直播间页面上手动发一条试试。',
        'channel.status.ready': '✓ 页面已就绪，现在可以在游戏里按发送键了。',
        'fields.behavior.consumeKeys': '热键对游戏隐藏',
        'fields.behavior.confirmTimeoutSeconds': '确认超时',
        'fields.behavior.soundFeedback': '提示音',
        'fields.behavior.autoSendOnRecognized': '识别后直接发送'
      },
      en: {
        nav: 'Voice Danmaku',
        intro: 'Send live-chat messages by voice while playing. Keys, overlay, recognition and delivery are configured here.',
        hintUnavailable: 'Settings service is unavailable; configuration cannot be read or written.',
        hintMemory: 'Settings are kept in this browser process only and are not written to the host document.',
        hintSaveHint: 'Changes are written when you press Save. Leave secret fields empty to keep them unchanged.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        'field.custom': 'Custom…',
        secretPlaceholder: 'Not set yet. Paste a value and press Save',
        secretKeep: 'Already set. Leave empty to keep it unchanged',
        secretClear: 'Clear',
        secretClearConfirm: 'Clear this saved secret? You will need to enter it again.',

        'document.open': 'Open configuration file',
        'document.opening': 'Opening…',
        'document.hint': 'Edit settings.yaml directly (changes hot-reload)',
        'document.unavailable': 'Opening the configuration file is not supported here',
        'document.failed': 'Could not open the file',

        'control.title': 'Running state',
        'control.hint': 'With auto-start off, the plugin does not run until you press Start, and no tray icon appears.',
        'control.start': 'Start',
        'control.starting': 'Starting…',
        'control.autoStart': 'Start with DSH',

        'groups.keys': 'Keys',
        'groups.mediaKeys': 'Media keys',
        'groups.overlay': 'Overlay',
        'groups.audio': 'Recording',
        'groups.asr': 'Recognition service',
        'groups.channel': 'Delivery channel',
        'groups.behavior': 'Behaviour',

        'fields.keys.record': 'Record key',
        'fields.keys.send': 'Send key',
        'fields.keys.cancel': 'Cancel key',
        'fields.mediaKeys.enabled': 'Enable media keys',
        'fields.mediaKeys.record': 'Record (toggle)',
        'fields.mediaKeys.send': 'Send',
        'fields.mediaKeys.cancel': 'Cancel',
        'mediaKeys.hint': 'Use media keys when ordinary keys do nothing in-game (anti-cheat blocks the keyboard hook). Press once to start recording, press again to stop and recognise — RegisterHotKey reports no key-up, so a toggle is the only reliable interaction. Media keys are shared with other programs, so they are never swallowed.',
        'mediaKeys.timeout': 'No media key arrived. You can type a key name (e.g. MediaTrackNext) or a key code instead.',
        'mediaKeys.disabledWarning': '⚠ Media keys are still off — the switch above is the master gate; nothing below takes effect until it is on. Pressing “Press a media key” turns it on for you.',
        'mediaKeys.pending': 'Enabled, but no registration result yet (the sidecar may not be running, or is restarting).',
        'mediaKeys.reportTitle': 'Media key registration: ',
        'mediaKeys.reportOk': 'registered: ',
        'mediaKeys.reportFailed': 'not registered: ',
        'mediaKeys.reportFailHint': ' (usually occupied by another program — pick another key, or close that program first)',
        'mediaKeys.listSep': ', ',
        'fields.overlay.enabled': 'Show overlay',
        'fields.overlay.fontSize': 'Font size',
        'fields.overlay.marginTop': 'Distance from top',
        'fields.overlay.opacity': 'Opacity',
        'fields.overlay.anchorXPercent': 'Horizontal position',
        'fields.overlay.clickThrough': 'Click-through to game',
        'fields.overlay.draggable': 'Draggable',
        'fields.audio.ffmpegPath': 'ffmpeg path',
        'fields.audio.device': 'Recording device',
        'fields.asr.baseUrl': 'API base URL',
        'fields.asr.model': 'Model',
        'fields.asr.apiKey': 'API key',
        'fields.asr.language': 'Recognition language',
        'fields.channel.roomId': 'Room ID',
        'fields.channel.maxLength': 'Maximum length',
        'fields.channel.page.port': 'Bridge port',
        'fields.channel.page.token': 'Bridge token',
        'fields.channel.minIntervalMs': 'Minimum interval',
        'fields.channel.maxPerHour': 'Hourly limit',

        'channel.page.hint': 'Danmaku are sent by the live room page you have open in Chrome: the plugin hands the text to an extension, which types it into the input box and clicks Send. The request is made by the page itself, so no credentials are stored in the plugin. Load the extension/ folder in Chrome first, then paste the token below into the extension popup.',
        'channel.status.down': '⚠ The local bridge is not listening. The port field above should show an error; you can also pick another port and save.',
        'channel.status.waiting': '⚠ The bridge is waiting, but no extension has connected yet. Check: (1) the Chrome extension is loaded and enabled; (2) a Bilibili live room page is open; (3) the port and token in the extension popup match this page.',
        'channel.status.not-ready': '⚠ An extension connected, but that page has no danmaku input box or send button. Make sure the tab really is a live room page and that you are logged in.',
        'channel.status.page-error': '⚠ An extension connected but failed while operating the page (usually a Bilibili front-end change). Try sending one danmaku by hand in the live room first.',
        'channel.status.ready': '✓ The page is ready — you can press the send key in-game now.',
        'fields.behavior.consumeKeys': 'Hide keys from game',
        'fields.behavior.confirmTimeoutSeconds': 'Confirm timeout',
        'fields.behavior.soundFeedback': 'Sound feedback',
        'fields.behavior.autoSendOnRecognized': 'Send without confirming'
      }
    };

    /**
     * 界面字段表。
     *
     * 这是浏览器侧唯一需要与宿主 schema 对齐的地方。刻意只列常用项：
     * 把 30 多个字段全铺出来会让页面变成一堵墙，而低频项直接改配置文件更合适。
     * `path` 是配置文档里的路径，写入走 `mutate()` 的 set 操作。
     */
    var SECTIONS = [
      {
        key: 'keys',
        fields: [
          { path: ['keys', 'record'], kind: 'text', placeholder: 'F9' },
          { path: ['keys', 'send'], kind: 'text', placeholder: 'F11' },
          { path: ['keys', 'cancel'], kind: 'text', placeholder: 'F10' }
        ]
      },
      {
        key: 'mediaKeys',
        fields: [
          { path: ['mediaKeys', 'enabled'], kind: 'boolean' },
          // ⚠️ 这三个字段原来带 `capture: true`（点了按钮再按一下媒体键自动填入），
          // 已经去掉 —— 它**原理上就走不通**：媒体键走 HID Consumer Control
          // （用途页 0x0C），由系统用 `RegisterHotKey` 派发，**浏览器收不到这些键的
          // keydown**（否则任何网页都能劫持你的播放/暂停键）。实测表现就是点了按钮
          // 显示"等待按键…"然后毫无反应。
          //
          // 现在直接填键名。合法的名字在 src/keys.ts 的媒体键表里，设置页的说明
          // 文字也列了常用的几个，写键码（如 179）同样可以。
          { path: ['mediaKeys', 'record'], kind: 'text', placeholder: 'AudioVolumeMute' },
          { path: ['mediaKeys', 'send'], kind: 'text', placeholder: 'MediaTrackNext' },
          { path: ['mediaKeys', 'cancel'], kind: 'text', placeholder: 'MediaPlayPause' }
        ]
      },
      {
        key: 'overlay',
        fields: [
          { path: ['overlay', 'enabled'], kind: 'boolean' },
          // `min`/`max` 必须与 config.ts 里 schema 的范围保持一致。它们有两个作用：
          //   1. 传给 `<input type=number>`，浏览器原生的校验和上下箭头会遵守；
          //   2. 把范围显示在界面上（形如 `10–96`）。
          //
          // 这不是装饰。schema 会拒绝超范围的值，而拒绝的表现是**"保存没反应"** ——
          // 用户把字号填成 100（上限 96）时会以为插件坏了。实测踩过。
          { path: ['overlay', 'fontSize'], kind: 'number', suffix: 'px', min: 10, max: 96 },
          { path: ['overlay', 'marginTop'], kind: 'number', suffix: 'px', min: 0, max: 2000 },
          { path: ['overlay', 'opacity'], kind: 'number', suffix: '%', min: 20, max: 100 },
          { path: ['overlay', 'anchorXPercent'], kind: 'number', suffix: '%', min: 0, max: 100 },
          { path: ['overlay', 'clickThrough'], kind: 'boolean' },
          { path: ['overlay', 'draggable'], kind: 'boolean' }
        ]
      },
      {
        key: 'audio',
        fields: [
          { path: ['audio', 'ffmpegPath'], kind: 'text', placeholder: '留空 = 自动探测' },
          { path: ['audio', 'device'], kind: 'text', placeholder: '留空 = 自动选第一个麦克风' }
        ]
      },
      {
        key: 'asr',
        fields: [
          { path: ['asr', 'baseUrl'], kind: 'text', placeholder: 'https://api.siliconflow.cn/v1' },
          // 候选来自**配置**（`asr.modelOptions`），不是硬编码 ——
          // 别人想加模型就进配置文件加一行，不用等插件更新。
          // 「自定义…」那个入口留着：临时试一个新模型不必先改配置。
          { path: ['asr', 'model'], kind: 'choice', optionsPath: ['asr', 'modelOptions'],
            placeholder: 'Qwen/Qwen3-ASR-1.7B' },
          { path: ['asr', 'apiKey'], kind: 'text', secret: true },
          { path: ['asr', 'language'], kind: 'text', placeholder: 'zh' }
        ]
      },
      {
        key: 'channel',
        fields: [
          // 这里曾经有一个「发送方式」下拉框和一个 Cookie 输入框。
          // 现在只剩一条通道（由浏览器页面发送），摆着它们只是噪音：
          // 一个没有选择余地的下拉框，和一个永远不会被用到的凭证输入框。
          // 配置里的 `provider` 字段保留着 —— 加第二条通道时把下拉框加回来即可。
          { path: ['channel', 'roomId'], kind: 'text', placeholder: '例如 12345' },
          { path: ['channel', 'page', 'port'], kind: 'number', min: 1024, max: 65535 },
          { path: ['channel', 'page', 'token'], kind: 'text' },
          // 长度上限：超过就截断，而且**在确认框里显示的就是截断后的内容**。
          // 判据是 String.length（汉字算 1），用户自己能核对。
          { path: ['channel', 'maxLength'], kind: 'number', suffix: '字', min: 20, max: 100 },
          { path: ['channel', 'minIntervalMs'], kind: 'number', suffix: 'ms', min: 1000, max: 60000 },
          { path: ['channel', 'maxPerHour'], kind: 'number', suffix: '条', min: 1, max: 600 }
        ]
      },
      {
        key: 'behavior',
        fields: [
          { path: ['behavior', 'consumeKeys'], kind: 'boolean' },
          { path: ['behavior', 'confirmTimeoutSeconds'], kind: 'number', suffix: '秒', min: 0, max: 120 },
          { path: ['behavior', 'soundFeedback'], kind: 'boolean' },
          { path: ['behavior', 'autoSendOnRecognized'], kind: 'boolean' }
        ]
      }
    ];

    // ---------------------------------------------------------------------
    // 样式：全部走 DSH 的 CSS 变量，自动跟随明暗主题
    // ---------------------------------------------------------------------
    var COLOR = {
      text: 'var(--dsw-alias-label-primary, #1a1a1a)',
      secondary: 'var(--dsw-alias-label-secondary, #666)',
      tertiary: 'var(--dsw-alias-label-tertiary, #999)',
      error: 'var(--dsw-alias-label-error, #d33)',
      border: 'var(--dsw-alias-border-l2, rgba(0,0,0,.08))',
      borderInput: 'var(--dsw-alias-border-l4, rgba(0,0,0,.16))',
      inputBg: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,.03))',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)'
    };

    /** 「自定义…」在下拉框里的取值。不是合法模型名，所以不会和候选撞上。 */
    var CUSTOM_VALUE = '__custom__';

    var CSS = {
      root: { padding: '4px 0 32px' },
      intro: { margin: '0 0 16px', fontSize: 13, lineHeight: 1.6, color: COLOR.secondary },
      notice: { margin: '0 0 16px', fontSize: 12, lineHeight: 1.6, color: COLOR.tertiary },
      group: { marginTop: 22 },
      groupTitle: { margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: COLOR.text },
      row: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
        borderTop: '0.5px solid ' + COLOR.border
      },
      labelWrap: { flex: 1, minWidth: 0 },
      label: { fontSize: 13, lineHeight: 1.5, color: COLOR.text },
      fieldHint: { marginTop: 2, fontSize: 12, lineHeight: 1.5, color: COLOR.tertiary },
      control: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
      input: {
        height: 34, minWidth: 180, padding: '0 12px', fontSize: 13,
        color: COLOR.text, background: COLOR.inputBg, fontFamily: 'inherit',
        border: '0.5px solid ' + COLOR.borderInput, borderRadius: 8
      },
      inputWide: { minWidth: 280 },
      select: {
        height: 34, minWidth: 180, maxWidth: 320, padding: '0 8px', fontSize: 13,
        color: COLOR.text, background: COLOR.inputBg, fontFamily: 'inherit',
        border: '0.5px solid ' + COLOR.borderInput, borderRadius: 8
      },
      suffix: { fontSize: 12, color: COLOR.tertiary, minWidth: 24 },
      // 数字字段的可填范围（`10–96`）。存在的理由是"静默失败"：schema 会拒绝超出
      // 范围的值，而拒绝看起来就只是"保存没反应"，用户完全无从判断哪里错了。
      rangeHint: { fontSize: 11, color: COLOR.tertiary, opacity: 0.7, whiteSpace: 'nowrap' },
      checkbox: { width: 16, height: 16, accentColor: COLOR.brand, cursor: 'pointer' },
      error: { margin: '4px 0 0', fontSize: 12, color: COLOR.error },
      footer: {
        display: 'flex', alignItems: 'center', gap: 12, marginTop: 24,
        paddingTop: 16, borderTop: '0.5px solid ' + COLOR.border
      },
      button: {
        height: 34, padding: '0 18px', fontSize: 13, fontFamily: 'inherit',
        color: '#fff', background: COLOR.brand, border: 'none',
        borderRadius: 8, cursor: 'pointer'
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      status: { fontSize: 12, color: COLOR.tertiary },
      // "已保存的密钥"用一串圆点表示：既让用户一眼看出"存过东西"，
      // 又不泄露长度之外的任何信息（长度本身也不敏感）。
      secretMask: {
        color: COLOR.tertiary,
        letterSpacing: 2,
        cursor: 'pointer'
      },
      // 清除按钮用红色描边而不是实心红：它是破坏性操作，需要显眼但不能像主操作。
      clearButton: {
        height: 34, padding: '0 12px', fontSize: 13, fontFamily: 'inherit',
        color: COLOR.error, background: 'transparent',
        border: '0.5px solid ' + COLOR.error, borderRadius: 8, cursor: 'pointer',
        whiteSpace: 'nowrap', flexShrink: 0
      },
      // 页脚"打开配置文件"：描边按钮，弱于主保存按钮
      outlineButton: {
        height: 34, padding: '0 14px', fontSize: 13, fontFamily: 'inherit',
        color: COLOR.text, background: 'transparent',
        border: '0.5px solid ' + COLOR.borderInput, borderRadius: 8, cursor: 'pointer',
        whiteSpace: 'nowrap', flexShrink: 0
      },
      // 「按一下媒体键」：捕获是一个次要动作，用描边按钮；捕获中换成品牌色，
      // 这样"现在在等你按键"这个状态不需要读文字就能看出来。
      // 分组说明与注册结果：比字段说明更靠上、更宽，所以单独一个样式。
      sectionHint: {
        margin: '2px 0 0', fontSize: 12, lineHeight: 1.6, color: COLOR.tertiary,
        maxWidth: 640
      },
      report: {
        margin: 0, padding: '8px 0 2px', fontSize: 12, lineHeight: 1.6,
        color: COLOR.secondary, maxWidth: 640
      },
      // 警告行：媒体键总开关没打开时用。用错误色而不是次要色 —— 这是一个
      // "你以为配好了其实没生效"的状态，用灰色等于没说。
      warning: {
        margin: '4px 0 2px', padding: '8px 10px', fontSize: 12, lineHeight: 1.6,
        color: COLOR.error, background: 'rgba(221,51,51,.06)',
        border: '0.5px solid ' + COLOR.error, borderRadius: 8, maxWidth: 640
      },
      documentRow: {
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        marginTop: 12, paddingTop: 12, borderTop: '0.5px solid ' + COLOR.border
      },
      // 顶部控制条：单独一栏，和下面的配置项视觉上区分开
      controlBar: {
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        padding: '14px 16px', marginBottom: 8,
        background: COLOR.inputBg, border: '0.5px solid ' + COLOR.borderInput,
        borderRadius: 10
      },
      controlText: { flex: 1, minWidth: 200 },
      controlTitle: { fontSize: 13, fontWeight: 600, color: COLOR.text },
      controlHint: { marginTop: 4, fontSize: 12, lineHeight: 1.5, color: COLOR.tertiary },
      controlActions: { display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 },
      switchLabel: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 13, color: COLOR.text, cursor: 'pointer', whiteSpace: 'nowrap'
      }
    };

    /** 从配置对象里按路径取值。 */
    function readPath(value, path) {
      var current = value;
      for (var i = 0; i < path.length; i += 1) {
        if (current === null || typeof current !== 'object') return undefined;
        current = current[path[i]];
      }
      return current;
    }

    /**
     * 选择本页要用的文案表。
     *
     * ## 为什么不用 `ctx.locale.bind()`
     *
     * 常规做法是 `var t = ctx.locale.bind(NS)`，然后让 locale 服务去查注册过的
     * 字典。本项目一开始就是这么写的，但实际运行中 `t()` 对每个 key 都返回了
     * **原始 key 本身**（界面显示 `fields.keys.record` 而不是「录音键」）。
     *
     * 查过真实的 locale 实现后确认：`t()` 只在"该命名空间没注册字典"时才这样
     * 返回，而我的注册写法与官方插件逐字一致（同样的 `ctx.effect(() =>
     * ctx.locale.register(NS, { zh, en }))`、同样的 bind 时机）。也就是说注册在
     * 运行时没有生效，而原因在浏览器那一侧，我无法从宿主机观测。
     *
     * 与其继续依赖一条我验证不了的链路，不如让这一页**自给自足**：
     * 文案直接从本模块的字典里取。代价是绕过了框架的统一词典管理；
     * 收益是界面文案不再可能变成原始 key —— 对使用者来说这才是要紧的。
     *
     * 我们仍然照常调用 `locale.register`：第一，官方接口该调就调；
     * 第二，如果将来那条链路生效了，本页也跟着有正确的语言。
     */
    function pickStrings(ctx) {
      var active = 'zh';
      try {
        // 服务暴露 getSnapshot()；取不到就退回中文（本插件的目标用户是中文用户）。
        var snapshot = ctx.locale.getSnapshot();
        if (snapshot !== null && typeof snapshot === 'object' &&
            typeof snapshot.active === 'string' && STRINGS[snapshot.active] !== undefined) {
          active = snapshot.active;
        }
      } catch (cause) {
        // 读不到就退回中文，不因为没有语言信息就让界面变成 key。
      }
      return STRINGS[active];
    }

    /** 把字段路径拼成 `keys.record` 这种形式，用于查文案。 */
    function pathKey(path) {
      return path.join('.');
    }

    /**
     * 把 sidecar 的注册回执渲染成一句话，没有可说的就返回 null。
     *
     * 回执格式是 `ok=A,B failed=C`（见 sidecar/src/Program.cs）。刻意在客户端
     * 拼句子而不是让 sidecar 发中文：sidecar 是语言中立的原生进程，而这一页要
     * 跟着 DSH 的语言走。
     */
    function formatMediaReport(raw, t) {
      if (typeof raw !== 'string' || raw.length === 0) return null;

      var ok = [];
      var failed = [];
      var parts = raw.split(' ');
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].indexOf('ok=') === 0) ok = parts[i].slice(3).split(',');
        else if (parts[i].indexOf('failed=') === 0) failed = parts[i].slice(7).split(',');
      }
      // 空串与"注册了零个键"都归到这里：没有内容就不显示，避免留下一行没用的字。
      ok = ok.filter(function (item) { return item.length > 0; });
      failed = failed.filter(function (item) { return item.length > 0; });
      if (ok.length === 0 && failed.length === 0) return null;

      var separator = t('mediaKeys.listSep');
      var text = t('mediaKeys.reportTitle');
      if (ok.length > 0) text += t('mediaKeys.reportOk') + ok.join(separator);
      if (failed.length > 0) {
        if (ok.length > 0) text += '; ';
        text += t('mediaKeys.reportFailed') + failed.join(separator) +
          t('mediaKeys.reportFailHint');
      }
      return text;
    }

    /**
     * 一个字段行。
     *
     * 抽成独立函数是为了让它自己持有 React hook —— 每个输入框需要自己的
     * "已改动但未保存"状态，把整个表单塞进一个组件里会让这部分状态管理变复杂。
     */
    function FieldRow(props) {
      var React_ = React;
      var h = React_.createElement;
      var field = props.field;
      var disabled = props.disabled;
      var busy = props.busy;
      var t = props.t;
      var onDraft = props.onDraft;
      // effective 由 SettingsPage 传入：它知道当前草稿，返回"该显示的值"。
      // 直接用 snapshot.value 会漏掉用户的未保存改动。
      var effective = props.effective;
      /** 本字段是否是"已保存的密钥"（宿主只告诉我们设没设过，不给值）。 */
      var secretSet = props.secretSet === true;
      /** 清除本字段（仅密钥字段用）。 */
      var onClear = props.onClear;

      var key = pathKey(field.path);
      var state = React_.useState(function () { return effective(field.path); });
      var current = state[0];
      var setCurrent = state[1];
      /**
       * 用户是否碰过这个字段。
       *
       * 只为密钥字段服务：它的"已保存"是**遮罩**而不是真值，所以用户一碰就得
       * 换回真输入框，否则他会在一个写着 ●●●● 的框里打字。
       */
      var touchedState = React_.useState(false);
      var touched = touchedState[0];
      var setTouched = touchedState[1];

      var update = function (next) {
        setCurrent(next);
        onDraft(field.path, next);
      };

      /**
       * 「自定义…」的展开状态（只给 `kind: 'choice'` 用）。
       *
       * 初始是否展开由"当前值在不在候选里"决定 —— 值不在候选里（比如用户手填过
       * 一个别的模型名）时，必须直接把文本框亮出来，否则那个值就没地方看了。
       */
      var customState = React_.useState(false);
      var customOpen = customState[0];
      var setCustomOpen = customState[1];

      var control;
      if (field.kind === 'select') {
        // 下拉框和复选框同理：选中值在渲染时现读 effective()，不用本地 state。
        // 切换发送方式会连带改变下面显示哪些字段，值必须立刻是新的。
        var selected = effective(field.path);
        var optionNodes = (field.options || []).map(function (option) {
          return h('option', { key: option.value, value: option.value },
            option.labelKey === undefined ? option.value : t(option.labelKey));
        });
        control = h('select', {
          style: CSS.select,
          value: selected === undefined ? '' : String(selected),
          disabled: disabled || busy,
          onChange: function (event) { update(event.target.value); }
        }, optionNodes);
      } else if (field.kind === 'boolean') {
        // 复选框的勾选状态**在渲染时现读 effective()**，不用本地 state。
        //
        // 为什么：`current` 只在挂载时取一次值，之后别处改了同一个字段它不会跟着
        // 变。捕获媒体键时我们会顺手把总开关打开（见上面的 onDraft），那时复选框
        // 就会停在"看起来没打开"的样子 —— 值是真的、显示是假的，比两者都错更难查。
        // 复选框没有"正在输入"的中间态，所以直接读是对的。
        control = h('input', {
          type: 'checkbox',
          style: CSS.checkbox,
          checked: effective(field.path) === true,
          disabled: disabled || busy,
          onChange: function (event) { update(event.target.checked); }
        });
      } else if (field.kind === 'number') {
        control = h('div', { style: CSS.control },
          h('input', {
            type: 'number',
            style: CSS.input,
            value: current === undefined || current === null ? '' : String(current),
            // 范围来自 SECTIONS，必须与 config.ts 的 schema 一致。渲染成原生属性，
            // 让上下箭头和浏览器自带的校验都遵守它。
            min: field.min,
            max: field.max,
            disabled: disabled || busy,
            onChange: function (event) {
              var raw = event.target.value;
              if (raw === '') return;
              var parsed = Number(raw);
              if (!isNaN(parsed)) update(parsed);
            }
          }),
          field.suffix !== undefined ? h('span', { style: CSS.suffix }, field.suffix) : null,
          // 把范围写出来。没有它，超范围的输入就只是"保存没反应"，用户无从判断。
          field.min !== undefined && field.max !== undefined
            ? h('span', { style: CSS.rangeHint }, field.min + '–' + field.max)
            : null
        );
      } else if (field.secret === true) {
        // 密钥类字段。宿主把它标记为 secret，下发的描述里**只有"是否已设置"、
        // 没有值本身**（SettingsSecretView.set）。所以界面能告诉用户"存过了"，
        // 但永远拿不到、也永远不显示那个值。
        //
        // 之前这里恒显示空，用户无法判断自己到底存过没有 —— 那是个真实的
        // 信息缺失。现在：已保存就显示一串 ●（一眼看出"有东西"），点进去编辑
        // 就变成密码输入框，按"未改动"处理，不保存就不会覆盖掉原值。
        var hasDraft = Object.prototype.hasOwnProperty.call(props.drafts, key);
        var useMask = secretSet && !hasDraft && !touched;
        var secretInput = h('input', {
          // 用明文而不是 password 类型：浏览器对未提交的密码框会弹"是否泄露密码"
          // 的警告（实测遇到过），而这里本来就没什么可藏 —— 已保存的值永远不下发，
          // 框里要么是遮罩圆点、要么是你自己刚输入的内容。
          type: 'text',
          style: Object.assign({}, CSS.input, CSS.inputWide,
            useMask ? CSS.secretMask : {}),
          value: useMask ? '●●●●●●●●' : (current === undefined ? '' : String(current)),
          placeholder: useMask ? '' : t(secretSet ? 'secretKeep' : 'secretPlaceholder'),
          disabled: disabled || busy,
          autoComplete: 'off',
          onFocus: function () {
            // 进入编辑：清掉遮罩与占位提示，让用户从一个干净的空框开始输入。
            setTouched(true);
            setCurrent('');
          },
          onChange: function (event) {
            setTouched(true);
            update(event.target.value);
          }
        });

        // 只在"确实存过东西"时才给清除按钮 —— 否则它是个没有作用的装饰。
        // 清除走 `unset` 操作（移除该键、回落到默认值），而不是写入空字符串：
        // 写空字符串会在用户文档里留下一个空值，语义上是"设置成了空"，
        // 而用户的意图是"我不用它了"。
        if (secretSet && !disabled) {
          control = h('div', { style: CSS.control },
            secretInput,
            h('button', {
              type: 'button',
              style: busy ? Object.assign({}, CSS.clearButton, CSS.buttonDisabled) : CSS.clearButton,
              disabled: busy,
              onClick: function () {
                // 清除是不可逆的（值拿不回来），所以先确认。
                // 这是这个页面上唯一一个破坏性操作。
                var confirmed = true;
                try {
                  confirmed = globalThis.confirm(t('secretClearConfirm'));
                } catch (cause) {
                  // 环境里没有 confirm（比如测试渲染）时，不阻塞操作。
                  confirmed = true;
                }
                if (!confirmed) return;
                if (onClear) onClear(field.path);
              }
            }, t('secretClear'))
          );
        } else {
          control = secretInput;
        }
      } else if (field.kind === 'choice') {
        // 候选 + 自定义。
        //
        // ## 候选来自配置，不是写死的
        //
        // `optionsPath` 指向配置里的一份数组（`asr.modelOptions`）。这样用户想加
        // 一个模型只需进配置文件加一行 —— 不必改代码、不必等插件更新。
        // 界面上刻意不给它输入框：它是"配置文件的配置"。
        //
        // ## 为什么不用 `<datalist>`
        //
        // 它是把输入框当**搜索框**用的：框里已经有值时，下拉只显示**匹配当前值**
        // 的那一个选项。用户实测的原话是"选哪个下拉框就只能看到哪个，另外两个
        // 看不到"—— 那正是这个行为。
        //
        // 所以用真正的下拉框：候选一眼看全；再留一个「自定义…」入口，
        // 服务商上了新模型也不用等插件更新。
        //
        // ## 候选读不出来时不能变成"空下拉框"
        //
        // 配置文件里的数组可能是空的、被手改成字符串、或者根本没这一项。这些
        // 情况下都必须退化成"只有自定义"—— 而不是渲染一个点开什么都没有的
        // 下拉框，那会让用户以为插件坏了。
        var presets = [];
        if (field.optionsPath) {
          var configured = effective(field.optionsPath);
          if (Array.isArray(configured)) {
            presets = configured.filter(function (value) {
              return typeof value === 'string' && value.length > 0;
            });
          }
        } else if (Array.isArray(field.options)) {
          presets = field.options.slice();
        }

        var isPreset = presets.indexOf(String(current)) >= 0;
        var selectValue = customOpen || !isPreset ? CUSTOM_VALUE : String(current);
        control = h('div', { style: CSS.control },
          h('select', {
            style: CSS.select,
            value: selectValue,
            disabled: disabled || busy,
            onChange: function (event) {
              var picked = event.target.value;
              if (picked === CUSTOM_VALUE) {
                // 切到自定义：先只弹出文本框，**不改值** —— 用户还没输入呢。
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              update(picked);
            }
          },
            presets.map(function (value) {
              return h('option', { key: value, value: value }, value);
            }),
            h('option', { key: CUSTOM_VALUE, value: CUSTOM_VALUE }, t('field.custom'))
          ),
          selectValue === CUSTOM_VALUE
            ? h('input', {
                type: 'text',
                style: Object.assign({}, CSS.input, CSS.inputWide),
                value: current === undefined ? '' : String(current),
                placeholder: field.placeholder !== undefined ? field.placeholder : '',
                disabled: disabled || busy,
                onChange: function (event) { update(event.target.value); }
              })
            : null
        );
      } else {
        // 普通文本字段。
        var textInput = h('input', {
          type: 'text',
          style: Object.assign({}, CSS.input,
            pathKey(field.path) === 'asr.baseUrl' ? CSS.inputWide : {}),
          value: current === undefined ? '' : String(current),
          placeholder: field.placeholder !== undefined ? field.placeholder : '',
          disabled: disabled || busy,
          onChange: function (event) { update(event.target.value); }
        });
        control = textInput;
      }

      return h('div', { style: CSS.row },
        h('div', { style: CSS.labelWrap },
          h('div', { style: CSS.label }, t('fields.' + key))
        ),
        control
      );
    }

    /**
     * 设置页面：一页承载全部分组。
     * 分成多个导航项会让左侧列表被本插件占满，一页里用小标题分组更好用。
     */
    function SettingsPage(props) {
      var React_ = React;
      var h = React_.createElement;
      var t = props.t;

      // 快照必须**订阅**，不能只在 inject 里读一次 —— 否则界面会停在首次渲染的
      // 值上，只有整页重载才更新（原因见 useScopeSnapshot 的注释）。
      // 无条件调用这个 hook，避免 hook 顺序随条件变化。
      var snapshot = useScopeSnapshot(props.scope);

      var draftsState = React_.useState({});
      var drafts = draftsState[0];
      var setDrafts = draftsState[1];
      var busyState = React_.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React_.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var savedState = React_.useState(false);
      var saved = savedState[0];
      var setSaved = savedState[1];
      // 「打开配置文件」按钮的状态。它调用一个远程方法，可能不可用，
      // 所以错误要能显示出来，而不是静默失败。
      var documentState = React_.useState(false);
      var documentBusy = documentState[0];
      var setDocumentBusy = documentState[1];
      var documentErrorState = React_.useState(null);
      var documentError = documentErrorState[0];
      var setDocumentError = documentErrorState[1];

      /**
       * 打开 settings.yaml。
       *
       * 走的是 DSH 的设置控制器远程方法（和标题栏那个"打开配置文件"同一个）。
       * 它可能不可用 —— 比如设置不是文件存储、或该命名空间没被装配 —— 所以
       * 这里全程用 try 包住，并把失败原因显示在按钮旁边。
       */
      var openDocument = function () {
        var open = props.openSettingsDocument;
        if (typeof open !== 'function') {
          setDocumentError(t('document.unavailable'));
          return;
        }
        setDocumentBusy(true);
        setDocumentError(null);
        Promise.resolve()
          .then(function () { return open(); })
          .then(function (result) {
            setDocumentBusy(false);
            // 远程方法返回结果对象：ok 为假时要取里面的 message。
            if (result !== undefined && result !== null && result.ok === false) {
              var message = result.error && result.error.message
                ? result.error.message
                : t('document.failed');
              setDocumentError(message);
            }
          })
          ['catch'](function (cause) {
            setDocumentBusy(false);
            setDocumentError(cause instanceof Error ? cause.message : String(cause));
          });
      };

      var disabled = snapshot.status !== 'ready' || snapshot.writable === false;

      var onDraft = function (path, next) {
        setDrafts(function (previous) {
          var copy = {};
          for (var k in previous) {
            if (Object.prototype.hasOwnProperty.call(previous, k)) copy[k] = previous[k];
          }
          copy[pathKey(path)] = next;
          return copy;
        });
        setSaved(false);
      };

      var commit = function () {
        var ops = [];
        for (var key in drafts) {
          if (!Object.prototype.hasOwnProperty.call(drafts, key)) continue;
          ops.push({ op: 'set', path: key.split('.'), value: drafts[key] });
        }
        if (ops.length === 0) return;
        setBusy(true);
        setError(null);
        props.mutate(ops).then(function () {
          setBusy(false);
          setDrafts({});
          setSaved(true);
          // 不需要手动刷新：scope 的 subscribe 会在写入折回镜像时触发重渲染。
        })['catch'](function (cause) {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      };

      /**
       * 订阅设置快照的变化，并用它驱动重渲染。
       *
       * ## 为什么必须订阅（一个真实的诊断失误）
       *
       * 我最初在 `inject()` 里读一次 `scope.getSnapshot()` 交给组件，以为快照会
       * 自己"传"进来。但 **inject 只在渲染前求值一次**，没有任何东西在快照变化时
       * 触发重渲染 —— 界面于是永远停在首次渲染的值上，只有整页重载（Ctrl+F5）
       * 才会重读。
       *
       * 用户的原话就是"我只有 ctrl+f5 以后那个输入框状态才会变"。我先误判成
       * "字段没重新挂载"，真正的根因是**缺少订阅**。
       *
       * 客户端 scope 的完整接口只有 getSnapshot / subscribe / mutate / set / unset；
       * `load()` 在实现里存在但**没有公开**，调它会报 "not a function"（也踩过）。
       * 所以 subscribe 是唯一正确的驱动方式。
       */
      function useScopeSnapshot(scope) {
        var counter = React.useState(0);
        var bump = counter[1];

        React.useEffect(function () {
          var disposed = false;
          var unsubscribe = scope.subscribe(function () {
            // 只用自增计数触发重渲染；值在渲染时现读 —— 不把快照复制进 state，
            // 就少一处可能不同步的地方。
            if (!disposed) bump(function (n) { return n + 1; });
          });
          return function () {
            disposed = true;
            if (typeof unsubscribe === 'function') unsubscribe();
          };
        }, []);

        return scope.getSnapshot();
      }

      var dirtyCount = Object.keys(drafts).length;
      var body = [];

      if (snapshot.status !== 'ready') {
        body.push(h('p', { key: 'unavailable', style: CSS.notice }, t('hintUnavailable')));
      } else if (snapshot.mode === 'memory') {
        body.push(h('p', { key: 'memory', style: CSS.notice }, t('hintMemory')));
      }
      body.push(h('p', { key: 'intro', style: CSS.intro }, t('intro')));

      // -------------------------------------------------------------------
      // 顶部控制区：手动启动 + 是否随 DSH 启动
      // -------------------------------------------------------------------
      //
      // 为什么放在最上面：这两件事是"要不要让它跑起来"，属于最先要决定的东西；
      // 埋在按键/浮层那些细节下面会让人找不到。
      // 注意：这里必须**先看草稿、再看已保存值**。
      //
      // 最初只读了 snapshot.value，后果是：点复选框时 onDraft 确实把值写进了草稿，
      // 但复选框仍按"已保存的值"渲染 —— 视觉上毫无变化，用户看到的就是
      // "点了没反应，怎么点都打不上勾"。所有可交互控件都要走这个读取顺序。
      var effective = function (path) {
        var draftKey = pathKey(path);
        if (Object.prototype.hasOwnProperty.call(drafts, draftKey)) return drafts[draftKey];
        return readPath(snapshot.value, path);
      };

      var autoStartValue = effective(['behavior', 'autoStart']);
      var launchBusy = busy;

      /**
       * 清除一个已填写的密钥。
       *
       * 用 `unset` 而不是"写入空字符串"：unset 移除用户文档里的那个键、回落到
       * schema 默认值，语义正是"我不用它了"；写空字符串则会在文档里留下一个
       * 空值，含义变成"设置成了空"。
       */
      var clearSecret = function (path) {
        setBusy(true);
        setError(null);
        props.mutate([{ op: 'unset', path: path }]).then(function () {
          setBusy(false);
          setSaved(true);
          // 不需要手动刷新：subscribe 会在写入折回镜像时触发重渲染。
        })['catch'](function (cause) {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      };

      // 「启动」按钮不改配置，而是把 launchToken 递增一次。宿主监听设置变化，
      // 看到值变了就拉起 sidecar。这样不用引入 remote 命名空间（那对一个
      // 启停动作来说太重），也复用了已有的设置热加载路径。
      var requestLaunch = function () {
        var current = effective(['behavior', 'launchToken']);
        var next = (typeof current === 'number' ? current : 0) + 1;
        var ops = [{ op: 'set', path: ['behavior', 'launchToken'], value: next }];
        var turnOn = autoStartValue !== true;
        // 顺手把"随 DSH 启动"打开：用户点「启动」的意图就是"我要它跑"，
        // 再让他去别处拨开关是多余的步骤。
        if (turnOn) ops.push({ op: 'set', path: ['behavior', 'autoStart'], value: true });
        setBusy(true);
        setError(null);
        props.mutate(ops).then(function () {
          setBusy(false);
          setSaved(true);
        })['catch'](function (cause) {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      };

      body.push(h('div', { key: 'control', style: CSS.controlBar },
        h('div', { style: CSS.controlText },
          h('div', { style: CSS.controlTitle }, t('control.title')),
          h('div', { style: CSS.controlHint }, t('control.hint'))
        ),
        h('div', { style: CSS.controlActions },
          h('button', {
            type: 'button',
            style: launchBusy || disabled
              ? Object.assign({}, CSS.button, CSS.buttonDisabled)
              : CSS.button,
            disabled: launchBusy || disabled,
            onClick: requestLaunch
          }, launchBusy ? t('control.starting') : t('control.start')),
          h('label', { style: CSS.switchLabel },
            h('input', {
              type: 'checkbox',
              style: CSS.checkbox,
              checked: autoStartValue === true,
              disabled: disabled || busy,
              onChange: function (event) {
                onDraft(['behavior', 'autoStart'], event.target.checked);
              }
            }),
            h('span', null, t('control.autoStart'))
          )
        )
      ));

      // 哪些密钥**已经填过**。数据来自宿主侧的派生字段 `behavior.secretStatus`.
      //
      // 为什么不用 DSH 描述符里的 secret `set` 标记：实测它不可用 ——
      // describe() 用"解析后的值"做 redact，而密钥字段的 schema 默认是空字符串，
      // `'' !== undefined` 恒为真，于是**每个密钥都被报成已设置**。
      // 只有宿主拿得到真实值，所以判断在宿主做，结论写进这个非密钥字段。
      var setSecrets = readPath(snapshot.value, ['behavior', 'secretStatus']);
      var isSecretSet = function (path) {
        if (!Array.isArray(setSecrets)) return false;
        var joined = pathKey(path);
        for (var s = 0; s < setSecrets.length; s += 1) {
          if (setSecrets[s] === joined) return true;
        }
        return false;
      };

      for (var i = 0; i < SECTIONS.length; i += 1) {
        var section = SECTIONS[i];
        var rows = [];
        // 分组说明：只在媒体键和发送通道这两组有 —— 它们的用法不看说明是猜不到的。
        if (section.key === 'mediaKeys') {
          rows.push(h('p', { key: 'mediaKeysHint', style: CSS.sectionHint }, t('mediaKeys.hint')));
        }
        if (section.key === 'channel') {
          rows.push(h('p', { key: 'channelHint', style: CSS.sectionHint }, t('channel.page.hint')));
        }
        var providerValue = effective(['channel', 'provider']);
        for (var j = 0; j < section.fields.length; j += 1) {
          var field = section.fields[j];
          // `onlyFor`：某些字段只在特定发送方式下有意义。把用不上的字段藏起来，
          // 比留一个"填了也不会生效"的输入框诚实。
          if (field.onlyFor !== undefined && field.onlyFor.indexOf(providerValue) < 0) continue;
          var fieldKey = pathKey(field.path);
          var secretIsSet = field.secret === true && isSecretSet(field.path);
          rows.push(h(FieldRow, {
            // key 里带上"是否已设置"：密钥被清除或写入后，这个值会翻转，
            // React 就重新挂载该行，FieldRow 内部的 useState 也随之重算。
            //
            // 为什么需要：FieldRow 把显示值存在自己的 useState 里，而 useState 的
            // 初始化**只在首次渲染生效**。所以清除密钥后快照虽然更新了，
            // 框里还留着旧值 —— 实测反馈正是"文件里确实清除了，但设置那里显示还有"。
            // 与其手写一堆"何时该重置本地 state"的判断，不如让挂载时机承担这件事。
            key: fieldKey + (secretIsSet ? '#set' : '#empty'),
            field: field,
            effective: effective,
            drafts: drafts,
            secretSet: secretIsSet,
            onClear: clearSecret,
            disabled: disabled,
            busy: busy,
            t: t,
            onDraft: onDraft
          }));
        }
        // 媒体键的注册回执。`RegisterHotKey` 失败是静默的（键被别的程序占用），
        // 没有这一行，用户面对"按这个键没反应"没有任何线索可查。
        if (section.key === 'mediaKeys') {
          if (effective(['mediaKeys', 'enabled']) !== true) {
            // 总开关没打开时把话说在最显眼的位置。这一条来自一次真实的排查：
            // 用户填好了两个键、点了保存、按下去毫无反应 —— 因为那三个键只有在
            // 总开关打开时才会被注册，而界面上没有任何地方说明这一点。
            rows.push(h('p', { key: 'mediaKeysDisabled', style: CSS.warning },
              t('mediaKeys.disabledWarning')));
          } else {
            var report = formatMediaReport(
              readPath(snapshot.value, ['behavior', 'mediaKeysReport']), t);
            // 启用了却没有任何回执：说明宿主还没拿到 sidecar 的回复
            // （sidecar 没在跑、或正在重启）。说出来，别让用户对着一个
            // 看起来很正常的界面猜"为什么按了没反应"。
            rows.push(report !== null
              ? h('p', { key: 'mediaKeysReport', style: CSS.report }, report)
              : h('p', { key: 'mediaKeysPending', style: CSS.report }, t('mediaKeys.pending')));
          }
        }
        // 页面通道有**四段**可能断掉的链路（桥没起 → 扩展没连 → 页面没就绪 →
        // 口令不一致），而它们在用户眼里是同一个现象："按了没反应"。
        // 这里把宿主算出来的结论直接显示出来。
        if (section.key === 'channel' && providerValue === 'page') {
          var bridgeStatus = readPath(snapshot.value, ['channel', 'page', 'status']);
          if (typeof bridgeStatus === 'string' && bridgeStatus.length > 0) {
            var statusText = t('channel.status.' + bridgeStatus);
            // 文案表里查不到就说明新增了状态值但忘了加文案 —— 那时宁可不显示，
            // 也不要显示一个原始 key（那是这个项目明确讨厌的失败方式）。
            if (statusText.indexOf('channel.status.') !== 0) {
              rows.push(h('p', {
                key: 'channelStatus',
                style: bridgeStatus === 'ready' ? CSS.report : CSS.warning
              }, statusText));
            }
          }
        }
        body.push(h('div', { key: section.key, style: CSS.group },
          h('h3', { style: CSS.groupTitle }, t('groups.' + section.key)),
          rows
        ));
      }

      body.push(h('div', { key: 'footer', style: CSS.footer },
        h('button', {
          type: 'button',
          style: busy || disabled || dirtyCount === 0
            ? Object.assign({}, CSS.button, CSS.buttonDisabled)
            : CSS.button,
          disabled: busy || disabled || dirtyCount === 0,
          onClick: commit
        }, busy ? t('saving') : t('save')),
        saved
          ? h('span', { style: CSS.status }, t('saved'))
          : h('span', { style: CSS.status }, t('hintSaveHint')),
        error !== null ? h('span', { style: CSS.error }, error) : null
      ));

      // ---------------------------------------------------------------
      // 页脚：打开配置文件
      // ---------------------------------------------------------------
      //
      // DSH 自己在设置面板标题栏有一个同名按钮，但它是**外壳的一部分**，在所有
      // 设置页上都显示，插件无法挪动或隐藏它。这里在本页底部再放一个明确位置的，
      // 因为"改这个插件的配置"和"打开 DSH 的设置文件"在本页语境下是一件事。
      body.push(h('div', { key: 'document', style: CSS.documentRow },
        h('button', {
          type: 'button',
          style: Object.assign({}, CSS.outlineButton,
            documentBusy || disabled ? CSS.buttonDisabled : {}),
          disabled: documentBusy || disabled,
          onClick: openDocument
        }, documentBusy ? t('document.opening') : t('document.open')),
        documentError !== null
          ? h('span', { style: CSS.error }, documentError)
          : h('span', { style: CSS.status }, t('document.hint'))
      ));

      return h('div', { style: CSS.root }, body);
    }

    // ---------------------------------------------------------------------
    // 插件本体
    // ---------------------------------------------------------------------

    /**
     * 需要的客户端服务。
     *
     * `remote.settings` 提供"打开配置文件"那个远程方法。确认过它在 web 组合里
     * 是装配的（dsh-web-app 的 patch 有 `- id: settings-controller`）——这一步
     * 必须确认，因为**注入一个不存在的命名空间会让整个插件加载失败**，
     * 用户会看到设置页直接消失。
     */
    var inject = ['slots', 'locale', 'configForms', 'remote.settings'];

    function apply(ctx) {
      // 照常注册字典：这是官方接口，该调就调；将来那条链路生效时本页跟着有正确语言。
      ctx.effect(function () {
        return ctx.locale.register(NAMESPACE, STRINGS);
      }, 'voice-danmaku: copy dictionaries');

      // 但界面文案不走 locale 查表，直接用本模块自己的字典（原因见 pickStrings）。
      var copy = pickStrings(ctx);
      var t = function (key) {
        // 先按完整 key 查（字典是扁平点号键），再按嵌套路径下钻。
        // 两种形式都支持，这样改字典结构时不会静默失效。
        var value = copy[key];
        if (value === undefined) value = readPath(copy, key.split('.'));
        return value === undefined ? key : value;
      };

      // 一页承载全部分组。分成多个导航项会让左侧列表被本插件占满，
      // 而这些配置是同一件事的不同侧面，放在一起更符合直觉。
      ctx.slots.inject('settings.section', function () {
        // DSH 0.2+ 的设置访问入口：`configForms.get(命名空间)` 直接返回一个 form
        // 控制器。旧版是按命名空间"绑定"出一个设置作用域对象，那个服务在 0.2 里
        // 被整个移除 —— 插件会因等待它而永久 pending，连带把 web boot 卡死（真实
        // 踩过一次，整个应用起不来）。两版的 form 接口高度一致：getSnapshot /
        // subscribe / mutate 同名同形，快照字段也相同，所以下游组件不用改。
        var scope = ctx.configForms.get(NAMESPACE);
        return ctx.slots.register({
          name: 'settings.section',
          id: 'voice-danmaku',
          order: 40,
          label: function () { return t('nav'); },
          locale: NAMESPACE,
          inject: function () {
            // 每次渲染都读一次最新快照：设置从别处改了，这里要跟着变。
            // 文案表也从这里下发，组件不依赖任何外部解析。
            return {
              t: t,
              copy: copy,
              // 把 scope 本身交给组件，让它订阅快照变化（而不是在这里读一次）。
              scope: scope,
              // 「打开配置文件」的调用入口。做成可选：拿不到时按钮会显示
              // "当前环境不支持"，而不是抛异常把整页带崩。
              openSettingsDocument: function () {
                var remote = ctx.remote;
                var settings = remote === undefined || remote === null ? undefined : remote.settings;
                if (settings === undefined || settings === null) {
                  return Promise.resolve({ ok: false });
                }
                return settings.openSettingsDocument();
              },
              mutate: function (ops) { return scope.mutate(ops); }
            };
          }
        }, SettingsPage);
      });
    }

    exports.name = 'voice-danmaku';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
