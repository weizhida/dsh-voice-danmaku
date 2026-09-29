/**
 * 页面世界里的钩子。
 *
 * 两个职责：
 *   1. **读回执** —— 包住页面自己的 `fetch` / `XMLHttpRequest`，把 `/msg/send`
 *      的响应捞出来（保留这个能力是因为：弹幕请求是页面自己发的，wbi 签名、
 *      csrftoken 都由 B 站前端算，我们不需要理解它）；
 *   2. **观测** —— 记录页面发了哪些 POST 请求。合成点击失败时，最想知道的就是
 *      "真人点一下的时候，页面到底做了什么"：走的哪个接口、带了什么参数、
 *      服务端回了什么。有了这个样本，一比就知道差在哪。
 *
 * ## 为什么必须跑在页面世界里（MAIN world）
 *
 * 内容脚本默认跑在隔离世界（ISOLATED world），那里看到的 `window.fetch` 跟页面
 * 用的**不是同一个函数**，包了也没用。所以 manifest 里把这个文件声明成
 * `"world": "MAIN"`，它和页面共享同一个 `window`。代价是**它没有任何 chrome.*
 * API**，只能靠 `window.postMessage` 把结果交给隔离世界的 `content.js`。
 *
 * ## 隐私边界
 *
 * * 所有 POST 只记 **URL 和状态码**；
 * * 只有**疑似发弹幕**的请求（URL 里含 send/msg/danmaku/barrage）才记请求体和
 *   响应体，各截断到 300 字符；
 * * 请求体里的 `csrf` / `csrf_token` / `bili_jct` 一律遮蔽 —— 这份数据会一路
 *   写到用户的设置文件里，不能把令牌带过去。
 *
 * 不修改任何请求、不修改任何响应，也不往任何外部服务器发送东西。
 */

(() => {
  /** 只关心这一个接口的回执。 */
  const TARGET_PATH = '/msg/send';

  /**
   * 这个请求是不是"发弹幕"。
   *
   * ⚠ 这里必须是**精确判定**，不能像第一版那样用 `url.includes('/msg/send')`：
   *   * `includes` 会把 `/msg/send_gift`、`/msg/sendHistory` 之类全算进来；
   *   * 更要命的是，只要页面上存在一个**周期性的**、URL 含这个片段的请求，
   *     它就会不断刷新我们记录的"最近回执"，于是发送时会把**别人的响应**
   *     当成自己那条弹幕的结果 —— 成败都可能判反。
   *
   * 发弹幕一定是 POST，所以连方法一起判。
   */
  function isDanmakuSend(url, method) {
    if (String(method ?? '').toUpperCase() !== 'POST') return false;
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.pathname === TARGET_PATH;
    } catch {
      return String(url).includes(TARGET_PATH);
    }
  }

  /** 观测缓冲条数。够看清一次操作，又不会把设置文件撑大。 */
  const MAX_OBSERVATIONS = 20;

  /** 什么样的 URL 值得连请求体一起记下来。 */
  const SUSPICIOUS = /(send|msg|danmaku|barrage)/i;

  /**
   * 埋点上报。**不记**。
   *
   * B 站每两秒就发一批（`data.bilibili.com/.../log/web`、`/log/web/xxx`），
   * 而缓冲只有十几条 —— 实测就是它们把缓冲刷满，把真正的发弹幕请求挤了出去，
   * 于是看观测的人（我）对着一堆埋点找不到真凶。它们和发弹幕毫无关系。
   */
  const TELEMETRY = /(data\.bilibili\.com|\/log\/web|postweb)/i;

  const observations = [];

  // 挂到页面的 window 上，用户可以在控制台里直接敲 `__voiceDanmakuLog` 查看。
  //
  // 为什么值得污染一个全局名：观测数据只在**页面里**存在，而反馈问题的人是
  // 用户 —— 让他"按 F12、输入这个词、把结果贴给我"，比让他重启宿主再让我去
  // 某个状态字段里翻要快得多。数组是引用，会实时更新。
  try {
    window.__voiceDanmakuLog = observations;
  } catch {
    /* 页面把 window 冻住时忽略，不影响功能 */
  }

  /** 发回隔离世界。用固定前缀，避免和页面自己的消息混淆。 */
  function emit(payload) {
    try {
      window.postMessage({ __voiceDanmaku: true, payload }, '*');
    } catch {
      /* 页面被卸载时会失败，忽略 */
    }
  }

  /**
   * 目前观察到过哪些被当成"发弹幕回执"的接口。
   *
   * 第一版因为匹配太宽，把无关的周期性请求也算了进来，而当时**日志里没有 URL**，
   * 只能靠猜。把它记下来，任何一次误判都能当场看见。
   */
  const outcomeSources = new Set();

  /** 遮蔽令牌。请求体可能带着 csrftoken，而这份数据会被写进用户的设置文件。 */
  function maskSecrets(text) {
    return String(text)
      .replace(/(csrf_token|csrf|bili_jct)=[^&\s]*/gi, '$1=<masked>')
      .replace(/"(csrf_token|csrf|bili_jct)"\s*:\s*"[^"]*"/gi, '"$1":"<masked>"');
  }

  /** 请求体的可读摘要。 */
  function summarizeBody(body) {
    if (body === undefined || body === null) return '';
    try {
      if (typeof body === 'string') return maskSecrets(body).slice(0, 300);
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return maskSecrets(body.toString()).slice(0, 300);
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        body.forEach((value, key) => {
          parts.push(`${key}=${value instanceof File ? `<file ${value.name}>` : String(value)}`);
        });
        return maskSecrets(parts.join('&')).slice(0, 300);
      }
    } catch {
      /* 其它类型不摘要 */
    }
    return `(${typeof body})`;
  }

  function observe(entry) {
    // 埋点不记（原因见 TELEMETRY 的说明）。它会把缓冲刷满，让真正要找的请求
    // 留不下来 —— 这是实际踩过的坑。
    if (TELEMETRY.test(entry.url) && !entry.url.includes(TARGET_PATH)) return;
    observations.push(entry);
    while (observations.length > MAX_OBSERVATIONS) observations.shift();
    emit({ observations });
  }

  /** 从响应文本里取出 `/msg/send` 的回执，连同来源 URL 一起转发。 */
  function reportOutcome(source, rawText) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    outcomeSources.add(source);
    // 顺手挂到控制台可查的那个全局上，排查时一眼能看出"回执都来自哪些接口"。
    try {
      window.__voiceDanmakuOutcomeSources = [...outcomeSources];
    } catch {
      /* window 被冻住时忽略 */
    }
    emit({
      // URL 一定要带上：排查时第一个要回答的问题就是"这到底是哪个接口的回执"。
      from: source,
      code: typeof parsed.code === 'number' ? parsed.code : undefined,
      message: String(parsed.message ?? parsed.msg ?? ''),
      at: Date.now()
    });
  }

  function shortUrl(url) {
    return String(url).replace(/^https?:\/\/[^/]+/, '').slice(0, 160);
  }

  /**
   * 完整 URL（含域名）。
   *
   * 回执来源必须记完整的：`/msg/send` 这个路径在 B 站**不止一个域名**下有
   * （直播弹幕在 `api.live.bilibili.com`，私信在别的域名）。只记路径的话，
   * 排查时会以为抓到的是弹幕接口，其实抓的是私信。
   */
  function fullUrl(url) {
    try {
      return new URL(String(url), location.href).href.slice(0, 200);
    } catch {
      return String(url).slice(0, 200);
    }
  }

  // ---- fetch ---------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const isTarget = isDanmakuSend(url, method);
      const suspicious = method === 'POST' && SUSPICIOUS.test(String(url));

      if (method === 'POST') {
        observe({
          kind: 'fetch',
          url: shortUrl(url),
          at: Date.now(),
          body: suspicious ? summarizeBody(init && init.body) : ''
        });
      }

      const promise = originalFetch.apply(this, arguments);

      // 只在响应上挂一个旁观者，绝不改变返回给页面的东西。
      return promise.then((response) => {
        if (method === 'POST') {
          try {
            response
              .clone()
              .text()
              .then((text) => {
                if (isTarget && text.length > 0) reportOutcome(`fetch ${fullUrl(url)}`, text);
                observe({
                  kind: 'fetch-response',
                  url: shortUrl(url),
                  status: response.status,
                  at: Date.now(),
                  body: suspicious || isTarget ? maskSecrets(text).slice(0, 300) : ''
                });
              })
              .catch(() => {});
          } catch {
            /* clone 失败（响应已被读取）时放弃，不影响页面 */
          }
        }
        return response;
      });
    };
  }

  // ---- XMLHttpRequest ------------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    const text = String(url ?? '');
    this.__voiceDanmakuMethod = String(method ?? 'GET').toUpperCase();
    this.__voiceDanmakuUrl = text;
    // 精确判定（POST + 路径正好是 /msg/send），见 isDanmakuSend 的说明。
    this.__voiceDanmakuTarget = isDanmakuSend(text, this.__voiceDanmakuMethod);
    this.__voiceDanmakuSuspicious = this.__voiceDanmakuMethod === 'POST' && SUSPICIOUS.test(text);
    if (this.__voiceDanmakuMethod === 'POST') {
      observe({ kind: 'xhr', url: shortUrl(text), at: Date.now(), body: '' });
      this.__voiceDanmakuObserved = true;
    }
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__voiceDanmakuObserved) {
      // 请求体是 send() 的参数，open() 时还拿不到 —— 在这里补上。
      observe({
        kind: 'xhr-body',
        url: shortUrl(this.__voiceDanmakuUrl),
        at: Date.now(),
        body: this.__voiceDanmakuSuspicious ? summarizeBody(body) : ''
      });
    }
    this.addEventListener('load', () => {
      let text = '';
      try {
        if (typeof this.responseText === 'string') text = this.responseText;
      } catch {
        /* 非文本响应 */
      }
      if (this.__voiceDanmakuTarget && text.length > 0) {
        reportOutcome(`xhr ${fullUrl(this.__voiceDanmakuUrl)}`, text);
      }
      if (this.__voiceDanmakuObserved) {
        observe({
          kind: 'xhr-response',
          url: shortUrl(this.__voiceDanmakuUrl),
          status: this.status,
          at: Date.now(),
          body: this.__voiceDanmakuSuspicious || this.__voiceDanmakuTarget
            ? maskSecrets(text).slice(0, 300)
            : ''
        });
      }
    });
    return originalSend.apply(this, arguments);
  };

  // ---- 就绪信号 ------------------------------------------------------------
  //
  // ⚠ 这里必须走**两条路**，因为 postMessage 那一条有自己的时序陷阱：
  // 本脚本在 document_start 跑，而隔离世界的 content.js 也要到 document_start
  // 才注册监听 —— 谁先谁后不确定。跨世界唯一共享的是 **DOM**，所以标志位写在
  // DOM 上，谁先谁后都读得到。
  try {
    document.documentElement.dataset.voiceDanmakuHook = '1';
  } catch {
    /* documentElement 还没就绪时忽略，下面的 ping 应答仍然有效 */
  }

  emit({ ready: true });

  // 回应隔离世界的 ping。这条路径和加载顺序无关，是最可靠的那个。
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.__voiceDanmaku !== true) return;
    const payload = data.payload;
    if (payload === null || typeof payload !== 'object') return;
    if (payload.ping === true) {
      emit({ ready: true });
      if (observations.length > 0) emit({ observations });
    }
  });
})();
