/**
 * 直播间页面里的操作员（隔离世界）。
 *
 * 职责只有三件：**找元素、填字、点发送**，然后把结果告诉后台。
 * 网络全部由后台 service worker 负责（MV3 里内容脚本的跨域请求会受页面 CORS
 * 约束，根本连不上本机端口）。
 *
 * ## 为什么按语义找元素，而不是写死 class 名
 *
 * B 站前端每个季度都在改。写死 `.chat-input` 这类选择器的扩展，改版当天就会
 * 静默失效 —— 而"静默"正是这个项目最讨厌的失败方式。所以这里的判据是语义的：
 *
 *   * 输入框：可见、且 placeholder 里提到"弹幕"（这是它唯一稳定的特征）；
 *   * 发送按钮：可见、且文字就是"发送"。
 *
 * 找不到时**明确报错**，并且这个错误会一路显示到插件的设置页上。
 */

(() => {
  'use strict';

  /** 轮询间隔。桥那边是"你来问我就给你"，所以这个值直接等于最大发送延迟。 */
  const POLL_INTERVAL_MS = 800;

  /** 页面状态的刷新间隔（按钮查找会扫 DOM，没必要每次轮询都做）。 */
  const STATUS_EVERY_N_POLLS = 3;

  /** 点击发送后等待服务端回执的上限。 */
  const OUTCOME_TIMEOUT_MS = 6000;

  /** 填入文字后、点击之前，给前端框架更新按钮状态的时间。 */
  const AFTER_FILL_DELAY_MS = 150;

  /**
   * 本标签页的随机 id，每次页面加载生成一个。
   *
   * 桥靠它区分"你开了几个直播间"。没有它的话，多个标签页会被认成同一个，
   * 派发就回到"谁先轮询谁拿走"—— 弹幕会随机发到其中一个直播间。
   *
   * 刻意不用 `chrome.tabs` 的 id：内容脚本拿不到自己的 tab id（那要绕后台问一圈），
   * 而这里需要的只是"这次页面加载"的标识 —— 页面一刷新就换新的，正好。
   */
  const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

  /**
   * 触发发送之后，等多久去检查输入框是否被清空。
   *
   * B 站是"点了就清空"（乐观更新），所以这个值不需要大；但它也**不能太小** ——
   * 清空得慢时会被误判成"没生效"，从而触发下一种方式，而**那会发出两条**。
   * 600ms 对"前端更新一个输入框"来说非常宽裕。
   */
  const CLEAR_CHECK_DELAY_MS = 600;

  // ---------------------------------------------------------------------------
  // 来自页面世界（page-hook.js）的回执
  // ---------------------------------------------------------------------------
  /** 通过 postMessage 收到过钩子的 ready。见 hookInstalled() 里的三层判据。 */
  let hookReady = false;
  /** 最近一次抓到的 /msg/send 响应。 */
  let lastOutcome = null;
  /**
   * 页面自己发出去的 POST 请求（由 page-hook.js 观测）。
   *
   * 这是一份**对照样本**：合成点击失败时，把它和"真人点一下时页面做的事"一比，
   * 就知道差在哪 —— 是接口不一样、参数少了，还是请求压根没发生。
   */
  let observedRequests = [];

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.__voiceDanmaku !== true) return;
    const payload = data.payload;
    if (payload === null || typeof payload !== 'object') return;
    if (payload.ready === true) {
      hookReady = true;
      return;
    }
    if (Array.isArray(payload.observations)) {
      observedRequests = payload.observations;
      return;
    }
    // 走到这里说明这是一条 `/msg/send` 的回执。
    //
    // 立刻打出来（而不是等到我们主动发送时）是有意的：**用户自己手动发一条**
    // 也能在控制台看到这一行，于是"钩子能不能抓到、接口是不是这个"当场就有答案。
    // 带上 `from`（来源接口）是关键 —— 第一版没有它，把无关的周期性请求也当成了
    // 回执，而日志里看不出区别。
    // 只把**看起来像回执**的消息当成回执：至少带 code 或 message 之一。
    //
    // 这条防御是实测换来的：上一版只判断"不是 ready、不是 observations"就当成
    // 回执，于是一个每两秒一次的无关请求（URL 里恰好带了 `/msg/send` 片段）
    // 让控制台每两秒刷一行"收到弹幕回执"，而且它会不断覆盖 lastOutcome ——
    // 发送判定可能拿着别人的响应当自己那条弹幕的结果。
    if (payload.code === undefined && payload.message === undefined) return;

    lastOutcome = payload;
    trace(`⚡ 收到弹幕接口回执（来自 ${payload.from ?? '未知接口'}）：`, payload);
  });

  /**
   * 页面世界里的钩子装好了吗。
   *
   * 三层判据 —— 第一版只用了最不可靠的那一层，结果钩子明明装上了，插件却一直
   * 收到"钩子没有生效"（实测踩到）：
   *
   *   1. postMessage 收到的 ready：依赖**加载顺序**。钩子在 `document_start` 发，
   *      而本脚本原本要到 `document_idle` 才注册监听，这条消息必然已经过去了；
   *   2. ping 的应答：与顺序无关，最可靠；
   *   3. DOM 上的标记位：跨世界唯一共享的东西，谁先谁后都读得到。
   */
  function hookInstalled() {
    if (hookReady) return true;
    try {
      if (document.documentElement.dataset.voiceDanmakuHook === '1') return true;
    } catch {
      /* 极端情况下读不到 DOM，当作没装好 */
    }
    return false;
  }

  /** 主动问一次（第 2 层判据）。这条路径和加载顺序无关。 */
  function pingHook() {
    try {
      window.postMessage({ __voiceDanmaku: true, payload: { ping: true } }, '*');
    } catch {
      /* 页面正在卸载时忽略 */
    }
  }

  // ---------------------------------------------------------------------------
  // 找元素
  // ---------------------------------------------------------------------------

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 8) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number.parseFloat(style.opacity || '1') < 0.1) return false;
    return true;
  }

  function textOf(element) {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 把元素描述成一行短文本，用于日志与诊断上报。
   *
   * 为什么需要它："找错了元素"是这类自动化最难自己发现的问题 —— 找到了一个
   * 可见的、placeholder 又像模像样的输入框，但它其实不是页面真正在用的那个。
   * 把标签名、class、placeholder 打出来，一眼就能看出来找的是不是东西。
   */
  function describeElement(element) {
    if (element === null || element === undefined) return '(没找到)';
    const tag = String(element.tagName || '?').toLowerCase();
    const cls = String(element.className || '').slice(0, 80);
    const placeholder = element.getAttribute('placeholder') || '';
    return `<${tag}${cls.length > 0 ? ` class="${cls}"` : ''}` +
      `${placeholder.length > 0 ? ` placeholder="${placeholder}"` : ''}>`;
  }

  /** 弹幕输入框的语义特征。 */
  function looksLikeDanmakuInput(element) {
    const hint = [
      element.getAttribute('placeholder'),
      element.getAttribute('data-placeholder'),
      element.getAttribute('aria-label')
    ]
      .filter(Boolean)
      .join(' ');
    // 「留言」是实测拿到的真实文案：placeholder 是「发送粉丝留言，TA在等你开口」。
    // 第一版只认「弹幕/说点/发言」，一个都不匹配，于是退回了面积兜底 ——
    // 那一步选错了元素，是整条链路发不出去的直接原因。
    return /弹幕|说点|发言|聊两句|留言|想说/.test(hint);
  }

  /**
   * 找弹幕输入框。
   *
   * 判据从强到弱，**顺序很重要**：
   *
   * 1. **「发送」按钮所在容器里的输入框** —— 这条最强：发送按钮和输入框必然在
   *    同一个组件内（实测的 DOM 是 `.chat-input-ctnr` 里同时装着 textarea 和
   *    `button.send-btn`），而"哪个按钮是发送"比"哪个框是弹幕框"好认得多。
   *    所以调用方应该**先找按钮、再把按钮传进来**。
   * 2. **页面自己的类名**（`.chat-input`）—— 比任何语义猜测都准，但它会随改版变。
   * 3. placeholder 语义 + 面积兜底 —— 最后的退路。
   *
   * @param anchor - 可选的锚点元素（通常是"发送"按钮）。
   */
  function findInput(anchor) {
    // 1. 锚点所在容器内的输入框。逐层向上找，但只找几层 ——
    //    再往外就会把整个页面都圈进来，那和全局搜索没区别了。
    if (anchor !== undefined && anchor !== null) {
      let node = anchor.parentElement;
      for (let depth = 0; node !== null && depth < 5; depth += 1) {
        const candidate = node.querySelector('textarea, [contenteditable="true"]');
        if (candidate !== null && isVisible(candidate)) return candidate;
        node = node.parentElement;
      }
    }

    // 2. 已知类名。
    const known = document.querySelector('textarea.chat-input, .chat-input-area textarea');
    if (known !== null && isVisible(known)) return known;

    // 3. 语义 + 面积。
    const candidates = Array.from(
      document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')
    ).filter(isVisible);

    const preferred = candidates.filter(looksLikeDanmakuInput);
    const pool = preferred.length > 0 ? preferred : candidates;
    if (pool.length === 0) return null;

    // 多个候选时挑面积最大的。
    let best = pool[0];
    let bestArea = 0;
    for (const element of pool) {
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = element;
      }
    }
    return best;
  }

  /**
   * 找发送按钮。
   *
   * 两轮：先只在真正的 `button` / `[role=button]` 里找（快，且几乎总是命中），
   * 找不到再扩大到所有元素（慢，只在真要发送时才做）。
   */
  function findSendButton(deep) {
    // 已知类名优先。实测的 DOM 是 `button.bl-button.send-btn`（里面 span.txt 写"发送"）。
    // 页面自己的类名比语义匹配准得多，代价是改版可能让它失效 —— 所以后面还有兜底。
    const known = document.querySelector('.send-btn-wrapper button, button.send-btn');
    if (known !== null && isVisible(known)) return known;

    const selectors = deep
      ? ['button', '[role="button"]', 'div', 'span', 'a']
      : ['button', '[role="button"]'];
    const elements = Array.from(document.querySelectorAll(selectors.join(','))).filter(isVisible);

    let exact = null;
    let fuzzy = null;
    for (const element of elements) {
      const text = textOf(element);
      if (text.length === 0 || text.length > 8) continue;
      if (text === '发送') {
        // 取最内层的那个：外层容器的文字也是"发送"，但点它不一定有效。
        // `exact.contains(element)` 为真说明 element 在 exact 里面（更深），换掉。
        if (exact === null || exact.contains(element)) exact = element;
      } else if (fuzzy === null && /发送/.test(text)) {
        fuzzy = element;
      }
    }
    return exact ?? fuzzy;
  }

  // ---------------------------------------------------------------------------
  // 填字
  // ---------------------------------------------------------------------------

  /**
   * 把文字写进输入框，并让前端框架知道值变了。
   *
   * 直接 `input.value = text` 对 Vue/React 的受控组件是**无效的**：框架记着自己
   * 那份值，下一帧就把你写的覆盖回去。必须走原型上的原生 setter，
   * 再手动派发 `input` 事件，框架才会认这次修改。
   */
  /**
   * 把文字写进输入框 —— 只做一种方式，由调用方决定用哪种。
   *
   * @param mode - `execCommand` / `type-char-by-char` / `native-setter`。
   */
  function fillWith(input, text, mode) {
    try {
      input.focus();
    } catch {
      /* 某些元素不支持 focus，忽略 */
    }

    if (input.isContentEditable || mode === 'contenteditable') {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        if (!document.execCommand('insertText', false, text)) input.textContent = text;
      } catch {
        input.textContent = text;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (mode === 'execCommand') {
      // 让浏览器**真的执行一次输入**：它会发出 beforeinput / input / textInput
      // 这一整套事件，前端框架对它的反应与真人打字一致。
      // 已废弃，但没有替代品 —— InputEvent 无法由脚本构造出同样完整的效果。
      try {
        if (typeof input.select === 'function') input.select();
        document.execCommand('insertText', false, text);
      } catch {
        /* 不支持时由调用方换下一种 */
      }
      return;
    }

    if (mode === 'type-char-by-char') {
      // 逐字符"打"进去，**按真人打字的完整事件序列**。
      //
      // 浏览器在真人打字时发的是这一串：keydown → beforeinput →（DOM 更新）
      // → input → keyup。第一版只发了中间的 `input`，而有些组件靠 keydown 或
      // beforeinput 更新自己的内部状态 —— 只发 input 时它们的状态始终是空的，
      // 于是点发送时前端认为"内容为空"，什么都不做。
      try {
        input.setRangeText('', 0, (input.value || '').length, 'end');
      } catch {
        input.value = '';
      }
      for (const ch of text) {
        const keyOptions = {
          key: ch, bubbles: true, cancelable: true, composed: true
        };
        try {
          input.dispatchEvent(new KeyboardEvent('keydown', keyOptions));
        } catch {
          /* 某些环境不支持 KeyboardEvent 构造，跳过 */
        }

        const start = typeof input.selectionStart === 'number'
          ? input.selectionStart
          : (input.value || '').length;
        const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;

        try {
          input.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, cancelable: true, inputType: 'insertText', data: ch
          }));
        } catch {
          /* 同上 */
        }

        try {
          input.setRangeText(ch, start, end, 'end');
        } catch {
          input.value = (input.value || '') + ch;
        }

        try {
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: false, inputType: 'insertText', data: ch
          }));
        } catch {
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        try {
          input.dispatchEvent(new KeyboardEvent('keyup', keyOptions));
        } catch {
          /* 同上 */
        }
      }
      return;
    }

    // 回退：走原型上的原生 setter。
    // 直接 `input.value = text` 对受控组件无效 —— 框架记着自己那份值，
    // 下一帧就把你写的覆盖回去。必须用原生 setter 再手动派发事件。
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor !== undefined && typeof descriptor.set === 'function') {
      descriptor.set.call(input, text);
    } else {
      input.value = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 依次尝试几种填字方式，直到**页面自己认了**这次输入。
   *
   * ⚠ 判据是「发送按钮变可用」，不是「DOM 的 value 里有字」。这两者可以不一致，
   * 而实测踩到的正是这种：value 里明明有字，页面却认为内容为空，于是三种点击
   * 方式全都没反应。按钮的可用状态是页面根据自己的内部输入状态算出来的，
   * 所以它才是唯一可信的信号。
   *
   * @returns 被页面接受的那种方式；都不被接受时返回空串。
   */
  async function fillUntilAccepted(input, button, text) {
    const modes = ['execCommand', 'type-char-by-char', 'native-setter'];

    for (const mode of modes) {
      // 逐字符那一种先"点一下"输入框：有些组件要到 mousedown/click 时才初始化
      // 编辑状态，只调 focus() 不够 —— 那样后面打进去的字它照样不认。
      if (mode === 'type-char-by-char') {
        try {
          dispatchMouseSequence(input);
        } catch {
          /* 派发失败就照常往下走 */
        }
      }

      fillWith(input, text, mode);
      await sleep(AFTER_FILL_DELAY_MS);

      if (readInput(input) !== text) {
        trace(`填字方式 ${mode}：文字没能写进 DOM`);
        continue;
      }

      const componentValue = readComponentValue(input);
      if (pageAcceptsInput(input, button)) {
        trace(`填字方式 ${mode}：页面接受了这次输入` +
          (componentValue === undefined ? '（按钮已可用）' : `（组件值为「${componentValue}」）`));
        return mode;
      }
      trace(`填字方式 ${mode}：DOM 里有字了，但页面仍认为内容为空` +
        (componentValue === undefined ? '（发送按钮依旧禁用）' : `（组件值是「${componentValue}」）`));
    }
    return '';
  }

  /** 读回输入框当前的内容，用来确认字真的写进去了。 */
  function readInput(input) {
    if (input.isContentEditable) return (input.textContent || '').trim();
    return (input.value || '').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 等页面自己收到 /msg/send 的响应。
   *
   * @param sinceMs - 只认这个时刻之后的回执，避免把上一次发送的结果当成这一次的。
   * @returns 抓到就返回；超时返回 null（**不是失败** —— 见调用处的处理）。
   */
  function waitForOutcome(sinceMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (lastOutcome !== null && typeof lastOutcome.at === 'number' && lastOutcome.at >= sinceMs) {
          clearInterval(timer);
          resolve(lastOutcome);
          return;
        }
        if (Date.now() - started > OUTCOME_TIMEOUT_MS) {
          clearInterval(timer);
          resolve(null);
        }
      }, 80);
    });
  }

  // ---------------------------------------------------------------------------
  // 触发发送
  // ---------------------------------------------------------------------------

  /**
   * 走一遍完整的鼠标事件序列。
   *
   * `element.click()` 只派发一个 click 事件，而不少前端组件（尤其是包了 UI 库的）
   * 真正监听的是 `mousedown`/`mouseup`，或者会在 mousedown 时才把自己标记为按下。
   * 只发 click 时它们什么都不做 —— 这正是本项目实测遇到的第一个失败。
   */
  function dispatchMouseSequence(element) {
    const rect = element.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    const hasPointer = typeof PointerEvent === 'function';
    if (hasPointer) {
      element.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { buttons: 1 })));
    }
    element.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, base, { buttons: 1 })));
    if (hasPointer) {
      element.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0 })));
    }
    element.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
    element.dispatchEvent(new MouseEvent('click', base));
  }

  /** 在输入框里按回车。B 站直播间支持回车发送 —— 这是与点按钮完全独立的另一条路。 */
  function pressEnter(input) {
    input.focus();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13
    };
    input.dispatchEvent(new KeyboardEvent('keydown', base));
    input.dispatchEvent(new KeyboardEvent('keypress', base));
    input.dispatchEvent(new KeyboardEvent('keyup', base));
  }

  /** 按钮此刻是不是被禁用了（框架还没跟上输入变化时常见）。 */
  function isDisabled(element) {
    if (element.disabled === true) return true;
    if (element.getAttribute('aria-disabled') === 'true') return true;
    return element.classList.contains('disabled') || element.classList.contains('is-disabled');
  }

  /**
   * 试着读出输入框**组件内部**的值。
   *
   * 这是判断"页面到底认没认这次输入"最直接的信号 —— 我们自己读的是 DOM 的
   * `value`，而页面用的是它自己状态里的那一份，两者可以不一致（实测就是不一致）。
   *
   * 靠不住是已知的：B 站前端用什么框架、实例挂在哪个属性上，都不是给外部用的
   * 约定。所以它只当**加分证据**，读不到就退回按钮的禁用状态。
   */
  function readComponentValue(input) {
    try {
      const instance = input.__vue__ ?? input.__vueParentComponent;
      if (instance === undefined || instance === null) return undefined;
      const data = instance.$data ?? instance.data ?? instance.ctx;
      if (data === undefined || data === null) return undefined;
      for (const key of ['value', 'inputValue', 'text', 'content', 'msg', 'message']) {
        const candidate = data[key];
        if (typeof candidate === 'string') return candidate;
      }
    } catch {
      /* 框架内部结构变了就算了，这不是我们的接口 */
    }
    return undefined;
  }

  /**
   * 页面是不是"认了"这次输入。
   *
   * 组合两个信号，因为单独任何一个都可能失准：
   *   * 组件内部的值（最准，但可能读不到）；
   *   * 发送按钮的可用状态（通用，但有些实现不用 `disabled` 属性表示禁用，
   *     只用 CSS class，那时它永远是"可用"）。
   */
  function pageAcceptsInput(input, button) {
    const componentValue = readComponentValue(input);
    if (componentValue !== undefined) return componentValue.length > 0;
    return !isDisabled(button);
  }

  /**
   * 触发一次发送，返回**哪一种方式生效了**。
   *
   * 为什么要试多种：第一版只调了 `button.click()`，结果页面上什么都没发生
   * （用户在直播间里确认过没有出现那条弹幕）。不同前端实现在这一点上差别很大，
   * 与其猜哪种对，不如都试一遍 —— 每种之后都用**同一个客观判据**判断是否生效：
   * **输入框被清空**。那是页面自己的反馈，不需要我们的钩子参与。
   *
   * 每试一种都要等够 `CLEAR_CHECK_DELAY_MS` 再判断：清空得慢时误判成"没生效"
   * 会触发下一种方式，而那会**发出两条**。
   *
   * @returns 生效的方式名；都没生效时返回 null。
   */
  async function triggerSend(input, button) {
    // 按钮被禁用时先等一拍：填字之后框架要一个 tick 才会解禁它。
    if (isDisabled(button)) {
      trace('发送按钮此刻是禁用的，等 300ms 再试');
      await sleep(300);
    }

    const attempts = [
      ['click', () => button.click()],
      ['mouse-sequence', () => dispatchMouseSequence(button)],
      ['enter-key', () => pressEnter(input)]
    ];

    for (const [name, fire] of attempts) {
      trace(`尝试触发方式：${name}`);
      try {
        fire();
      } catch (cause) {
        trace(`  ${name} 抛异常：${cause instanceof Error ? cause.message : String(cause)}`);
        continue;
      }
      await sleep(CLEAR_CHECK_DELAY_MS);
      if (readInput(input).length === 0) {
        trace(`  ${name} 生效（输入框已清空）`);
        return name;
      }
      trace(`  ${name} 没有反应（输入框里的文字还在）`);
    }
    trace('三种触发方式都没生效');
    return null;
  }

  // ---------------------------------------------------------------------------
  // 执行一次发送
  // ---------------------------------------------------------------------------

  let lastError = '';
  /** 最近一次发送是哪条触发路径生效的（诊断用，会一路报到插件的设置页）。 */
  let lastTrigger = '';
  /** 最近一次用的填字写法。 */
  let lastFillMode = '';
  /**
   * 填入文字之后，页面是否**仍然认为内容为空**。
   *
   * 这是判断"前端到底认没认这次输入"最关键的信号：我们只能看到 DOM 的 value，
   * 而页面用的是它自己状态里的那一份 —— 两者可以不一致。实测就是不一致：
   * DOM 里明明有字，点发送却什么都不发生（因为前端认为内容为空，直接返回）。
   */
  let lastButtonDisabled = false;
  /** 最近一次找到的输入框/按钮长什么样（诊断用：找错元素是最难自查的问题）。 */
  let lastInputElement = '';
  let lastButtonElement = '';

  /**
   * 打一行日志到页面控制台（F12 就能看到）。
   *
   * 这不是调试残留，是**给用户的证据**：扩展跑在页面里，插件那边只能看到结果，
   * 看不到过程。用户在直播间按 F12 就能把"钩子装没装上、哪种触发方式生效了、
   * 服务端回了什么"原样发给维护者，而不必靠猜。
   */
  function trace(...args) {
    try {
      console.log('[语音弹幕]', ...args);
    } catch {
      /* 页面被卸载时忽略 */
    }
  }

  async function execute(task) {
    // **先找"发送"按钮，再拿它当锚点找输入框。**
    //
    // 顺序反过来（先找输入框）就只能靠 placeholder 语义或"面积最大"来猜，
    // 而实测证明那会猜错：真实 placeholder 是「发送粉丝留言，TA在等你开口」，
    // 不含"弹幕"两个字，于是选成了别处的输入框，字填进去、点的却是弹幕的发送
    // 按钮 —— 前端认为内容为空，什么都不发生。
    const button = findSendButton(false) ?? findSendButton(true);
    if (button === null) {
      return { ok: false, message: '没找到"发送"按钮' };
    }

    const input = findInput(button);
    if (input === null) {
      return { ok: false, message: '没找到弹幕输入框（这个页面是直播间吗？）' };
    }

    // 输入框里已经有内容时**不覆盖**：用户可能正自己打着字。
    // 丢掉用户已经打的字，比这次弹幕没发出去糟糕得多。
    const existing = readInput(input);
    if (existing.length > 0) {
      return {
        ok: false,
        message: `直播间输入框里已经有「${existing.slice(0, 12)}」，为避免覆盖它，这次没有发送`
      };
    }

    const clickedAt = Date.now();
    lastInputElement = describeElement(input);
    lastButtonElement = describeElement(button);
    trace(`准备发送「${task.text}」；输入框=${lastInputElement}；按钮=${lastButtonElement}`);

    // 依次尝试几种填字方式，直到页面自己认了这次输入。
    lastFillMode = await fillUntilAccepted(input, button, task.text);
    if (readInput(input) !== task.text) {
      trace('三种填字方式都没能把文字写进输入框 —— 页面结构可能变了');
      return { ok: false, message: '文字没能填进输入框（页面结构可能变了）' };
    }

    lastButtonDisabled = !pageAcceptsInput(input, button);
    if (lastButtonDisabled) {
      trace('⚠ 三种填字方式都没能让页面认为有内容 —— 点击不会有任何效果');
      return {
        ok: false,
        message: '文字填进了输入框，但页面始终认为内容为空（发送按钮一直是禁用的）。' +
          '这通常是 B 站输入框改成了自定义组件，需要更新扩展的填字方式'
      };
    }
    // 依次试几种触发方式，用"输入框是否被清空"挑出有效的那一种。
    const firedBy = await triggerSend(input, button);
    const cleared = firedBy !== null;
    lastTrigger = cleared ? firedBy : 'none';
    if (!cleared) {
      // 走到这里说明三种方式都没让输入框清空。**不要**再试第四遍 ——
      // 每多试一次就多一次"其实已经发出去了"的风险，而这三种已经覆盖了
      // 主流前端实现。失败就如实报失败，让用户自己看一眼直播间。
      trace('三种触发方式都没生效，不再重试');
    }

    // 钩子没装好就别等满 6 秒了 —— 那 6 秒里什么都不会来。
    const outcome = await waitForOutcome(clickedAt, hookInstalled() ? OUTCOME_TIMEOUT_MS : 2000);
    if (outcome !== null) {
      const code = typeof outcome.code === 'number' ? outcome.code : undefined;
      trace('收到服务端回执：', outcome);
      if (code === 0) return { ok: true, code: 0, message: outcome.message };
      return {
        ok: false,
        code,
        message: outcome.message.length > 0 ? outcome.message : `页面回报 code=${code ?? '?'}`
      };
    }

    trace(hookInstalled()
      ? '没抓到服务端回执（钩子装上了，但这次请求没被它看到）'
      : '页面钩子没生效（Chrome 版本低于 111，或页面结构变了），只能看输入框判断');

    // 没抓到回执，只能靠页面自己的表现下结论 —— 而且必须说清这个结论有多弱。
    //
    // "输入框被清空"表示**页面前端接受了**这次发送，不代表服务端也接受了
    // （风控、禁言这类拒绝同样会先清空输入框）。所以措辞不能写成"已发送"。
    if (cleared) {
      return {
        ok: true,
        message: `页面已接受（${firedBy} 生效，输入框已清空），但没抓到服务端回执`
      };
    }
    return {
      ok: false,
      message: '点了发送但页面没有反应：三种触发方式都试过，输入框里的文字一直在'
    };
  }

  // ---------------------------------------------------------------------------
  // 与后台通信
  // ---------------------------------------------------------------------------

  /** 扩展被重载后，旧的 content script 会失去上下文；那时安静退出，别刷错误。 */
  let contextAlive = true;

  async function send(message) {
    if (!contextAlive) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (cause) {
      contextAlive = false;
      return null;
    }
  }

  let pollCount = 0;
  let cachedHasButton = false;

  async function pollOnce() {
    if (!contextAlive) return;

    const task = await send({ cmd: 'poll', tab: TAB_ID, href: location.href });
    if (task === null) return;

    pollCount += 1;
    if (pollCount % STATUS_EVERY_N_POLLS === 1) {
      // 顺便再问一次钩子在不在。DOM 标记已经能兜底，但这条路径与加载顺序无关，
      // 万一标记位因为某种原因没写上（页面早期、CSP 异常），它还能救回来。
      pingHook();
      cachedHasButton = findSendButton(false) !== null;
      const currentInput = findInput();
      await send({
        cmd: 'page',
        tab: TAB_ID,
        href: location.href,
        title: document.title,
        hasInput: currentInput !== null,
        hasButton: cachedHasButton,
        hookReady: hookInstalled(),
        error: lastError,
        // 用户此刻在输入框里打了什么。它能证明"我们找的输入框就是他真正在用的
        // 那个" —— 如果他在页面上打的字这里读不到，那就是找错元素了。
        inputValue: currentInput === null ? '' : readInput(currentInput).slice(0, 60),
        // 诊断字段：出了问题时，"哪条触发路径生效了"和"页面认没认这次输入"
        // 是判断下一步该改哪里的两个关键事实，而它们在浏览器里用户看不到。
        lastTrigger,
        fillMode: lastFillMode,
        buttonDisabled: lastButtonDisabled,
        inputElement: lastInputElement,
        buttonElement: lastButtonElement,
        // 页面自己发的 POST 请求（对照样本），截断后上报。
        observations: JSON.stringify(observedRequests).slice(0, 3500),
        userAgent: navigator.userAgent
      });
    }

    if (typeof task.id !== 'string') return;

    let result;
    try {
      result = await execute(task);
    } catch (cause) {
      result = { ok: false, message: `扩展内部出错：${cause instanceof Error ? cause.message : String(cause)}` };
    }
    lastError = result.ok ? '' : result.message ?? '';
    await send(Object.assign({ cmd: 'result', id: task.id }, result));
  }

  // 定时轮询。刻意**不用长轮询**：后台 service worker 空闲 30 秒会被回收，
  // 长连接得靠心跳吊着，而心跳断了是静默的。轮询没有这个依赖 ——
  // 每次消息都会把 service worker 叫醒，叫醒是可靠的。
  setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);

  // 立刻跑一次，省掉开局的 800ms。
  // 此时（document_start）DOM 还是空的，页面状态会先报一轮"找不到输入框"，
  // 几百毫秒后自然就对了 —— 宿主每 5 秒才汇总一次状态，看不到这一瞬。
  pingHook();
  void pollOnce();
})();
