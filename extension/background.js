/**
 * 后台 service worker：唯一负责网络的地方。
 *
 * ## 为什么网络必须在这里
 *
 * MV3 里内容脚本的跨域请求**受页面 CORS 约束**（请求的 Origin 是
 * `live.bilibili.com`），所以内容脚本根本连不上 `http://127.0.0.1:端口`。
 * service worker 有 `host_permissions`，不受这条限制。
 *
 * ## 关于 service worker 会被回收
 *
 * Chrome 会在空闲 30 秒后回收它。这个设计**不依赖它一直活着** ——
 * 内容脚本每次发消息都会把它叫醒，而消息唤醒是可靠的。所以这里不做任何
 * 保活（心跳/WebSocket/定时器），也就不存在"心跳断了但没人知道"这种状态。
 * 最坏情况只是每次冷启动多花几十毫秒。
 */

'use strict';

/** 默认值。用户在扩展弹窗里改，存在 chrome.storage.local。 */
const DEFAULTS = { port: 39217, token: '' };

async function readSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    port: Number(stored.port) || DEFAULTS.port,
    token: String(stored.token ?? '')
  };
}

/** 桥的地址。口令放在查询串里 —— 本机回环连接，不走网络。 */
function bridgeUrl(settings, path, extraQuery) {
  const url = new URL(`http://127.0.0.1:${settings.port}${path}`);
  url.searchParams.set('token', settings.token);
  if (extraQuery !== undefined) {
    for (const [key, value] of Object.entries(extraQuery)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * 发一个请求到桥。
 *
 * 超时是必须的：桥没起来时 fetch 会挂很久，而内容脚本每秒都在问，
 * 没有超时会堆起一堆悬挂的请求。
 */
async function callBridge(path, options) {
  const settings = await readSettings();
  if (settings.token.trim().length === 0) {
    return { ok: false, offline: true, message: '扩展还没配置口令（点扩展图标填一下）' };
  }

  const method = options?.method ?? 'GET';
  const url = bridgeUrl(settings, path, options?.query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(options?.body ?? {}) : undefined
    });

    if (response.status === 403) {
      return { ok: false, offline: false, message: '口令不对：扩展里的口令和插件设置里的不一致' };
    }
    if (!response.ok) {
      return { ok: false, offline: false, message: `本地桥返回 HTTP ${response.status}` };
    }
    return { ok: true, data: await response.json() };
  } catch (cause) {
    // 连接被拒 = 插件没在跑或端口不对；超时 = 桥在但没响应。两种都要说清楚。
    const message = cause instanceof Error && cause.name === 'AbortError'
      ? '本地桥没有响应（超时）'
      : '连不上本地桥（插件没在运行？端口填错了？）';
    return { ok: false, offline: true, message };
  } finally {
    clearTimeout(timer);
  }
}

/** 处理来自内容脚本与弹窗的消息。 */
async function handle(message) {
  switch (message?.cmd) {
    case 'poll': {
      const result = await callBridge('/poll', {
        // `tab` 是内容脚本自己生成的标签页 id，`href` 是页面地址。
        // 桥靠前者区分"你开了几个直播间"，靠后者在配了房间号时挑出唯一的目标。
        query: { tab: message.tab ?? '', href: message.href ?? '' }
      });
      if (!result.ok) return { offline: true, message: result.message };
      return result.data ?? {};
    }
    case 'page': {
      const result = await callBridge('/page', {
        method: 'POST',
        query: { tab: message.tab ?? '' },
        body: {
          href: message.href,
          title: message.title,
          hasInput: message.hasInput,
          hasButton: message.hasButton,
          hookReady: message.hookReady,
          error: message.error
        }
      });
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    }
    case 'result': {
      const result = await callBridge('/result', {
        method: 'POST',
        body: {
          id: message.id,
          ok: message.ok,
          code: message.code,
          message: message.message
        }
      });
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    }
    case 'status': {
      const result = await callBridge('/status');
      if (!result.ok) return { ok: false, offline: true, message: result.message };
      return { ok: true, snapshot: result.data };
    }
    case 'settings': {
      return { ok: true, settings: await readSettings() };
    }
    case 'save': {
      await chrome.storage.local.set({
        port: Number(message.port) || DEFAULTS.port,
        token: String(message.token ?? '')
      });
      return { ok: true };
    }
    default:
      return { ok: false, message: `未知指令：${String(message?.cmd)}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((cause) => {
      sendResponse({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    });
  // 返回 true 表示会异步调用 sendResponse。
  return true;
});
