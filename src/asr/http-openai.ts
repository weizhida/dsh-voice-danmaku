/**
 * OpenAI 兼容的语音转写引擎。
 *
 * 用这个接口的服务很多（硅基流动、OpenAI 官方、各类自建网关），
 * 请求形状都是 `POST {baseUrl}/audio/transcriptions` 的 multipart 表单：
 * 文件 + model + language。所以一个实现能覆盖一大片。
 *
 * 只依赖 Node 内置的 `fetch` / `FormData` / `Blob`，不引入 HTTP 客户端库。
 */

import type { AsrEngine, TranscribeRequest } from './types.js';
import { error as logError } from '../logger.js';

/** 构造参数。从设置里来。 */
export interface OpenAiCompatibleAsrOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 识别语言；空串表示交给服务自动判断。 */
  language: string;
}

/** 服务端错误响应里我们能读到的部分。 */
interface ErrorEnvelope {
  error?: { message?: string; code?: string; type?: string };
  message?: string;
}

export class OpenAiCompatibleAsr implements AsrEngine {
  readonly id = 'openai-compatible';

  constructor(private readonly options: OpenAiCompatibleAsrOptions) {}

  check(): string[] {
    const problems: string[] = [];
    if (this.options.apiKey.trim().length === 0) {
      problems.push('未设置转写服务的 API 密钥（设置 → 语音弹幕 → 识别服务）');
    }
    if (this.options.baseUrl.trim().length === 0) {
      problems.push('未设置转写服务的 API 地址');
    }
    if (this.options.model.trim().length === 0) {
      problems.push('未设置转写模型名');
    }
    return problems;
  }

  async transcribe(request: TranscribeRequest): Promise<string> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

    // audio/wav：我们上传的确实是 WAV（见 audio.ts 的 wrapWav）。
    // 这里的 `as unknown as BlobPart` 是 TypeScript 库定义的局限：
    // Node 的 Blob 接受 Uint8Array，但 DOM 的 BlobPart 类型没写进 Uint8Array。
    const blob = new Blob([request.audio as unknown as BlobPart], { type: 'audio/wav' });
    const form = new FormData();
    form.append('file', blob, 'speech.wav');
    form.append('model', this.options.model);
    // 语言留空时干脆不发这个字段：发空串有些服务会当成"语言是空字符串"而报错。
    const language = request.language.trim();
    if (language.length > 0) form.append('language', language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    if (request.signal !== undefined) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: controller.signal
      });
    } catch (cause) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new Error(`转写超时（超过 ${Math.round(request.timeoutMs / 1000)} 秒）`);
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      logError('转写请求失败:', reason);
      throw new Error(`无法连接转写服务：${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(await describeFailure(response));
    }

    // 兼容两种返回：纯文本，或 `{"text": "..."}`。
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(raw) as { text?: unknown };
        if (typeof parsed.text === 'string') return parsed.text;
      } catch {
        /* 声称是 JSON 但解析不了：当作纯文本处理，比直接报错更有用 */
      }
    }
    return raw;
  }
}

/**
 * 服务端文案里出现这些词，就是余额问题。
 *
 * 为什么要靠文字而不是状态码：**余额不足的状态码不止一个**（402、403、429 都见得到），
 * 而各家的文案里一定会有线索（"余额不足" / "insufficient balance" / "quota"）。
 * 只看状态码的话，用户会拿到"请检查 API 密钥是否正确" —— 然后去反复检查一个
 * 根本没错的密钥，而真正该做的是充值。
 */
const OUT_OF_CREDIT = /(余额|欠费|不足|quota|insufficient|balance|credit|arrears|payment)/i;

/**
 * 把 HTTP 失败翻译成用户看得懂的话。
 *
 * 用户需要的是"去做什么" —— 改密钥、充值、还是等一会儿。状态码本身对他没有意义。
 *
 * **余额不足要单独认出来**：它是唯一一种"不做点什么就永远好不了"的失败，
 * 也是最容易被误判成别的原因的一种。
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const raw = await response.text();
    if (raw.trim().length > 0) {
      try {
        const envelope = JSON.parse(raw) as ErrorEnvelope;
        detail = envelope.error?.message ?? envelope.message ?? raw.slice(0, 300);
      } catch {
        detail = raw.slice(0, 300);
      }
    }
  } catch {
    /* 读不出响应体就算了，状态码本身还有信息 */
  }

  const suffix = detail.length > 0 ? `：${detail}` : '';

  // 先看服务端自己说了什么 —— 这一条优先于状态码。
  if (OUT_OF_CREDIT.test(detail)) {
    return `转写服务账户余额不足（HTTP ${response.status}）${suffix}。` +
      '请到服务商控制台充值，充值后立刻可用，不需要重启。';
  }

  switch (response.status) {
    case 401:
      return `API 密钥无效或已过期（HTTP 401）${suffix}。请到设置 → 语音弹幕 → 识别服务 重新填写。`;
    case 402:
      return `转写服务要求付费（HTTP 402）${suffix}。多半是账户余额不足，请到服务商控制台充值。`;
    case 403:
      // 403 既可能是密钥权限问题，也可能是余额不足 —— 余额那种已经被上面拦掉了，
      // 所以这里把两种可能都告诉用户，而不是断言是密钥错了。
      return `转写服务拒绝了这次请求（HTTP 403）${suffix}。` +
        '可能是密钥权限不足，也可能是账户余额不足，请到服务商控制台确认。';
    case 429:
      return `请求过于频繁或额度用尽（HTTP 429）${suffix}。稍等几秒再试；若反复出现，去看一眼账户额度。`;
    default:
      return `转写服务返回 HTTP ${response.status}${suffix}`;
  }
}
