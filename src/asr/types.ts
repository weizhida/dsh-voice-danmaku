/**
 * 语音识别引擎接口。
 *
 * 刻意只有一个方法：**音频进、文字出**。
 * 不做"流式""部分结果"这类能力 —— 当前的交互是"说完再识别"，
 * 那些能力没有消费方，加进来只会变成需要维护的死代码。
 * 将来真要做边说边出字，再加一个可选方法，而不是现在先空着。
 */

/** 一次转写请求。 */
export interface TranscribeRequest {
  /** 完整的 WAV 音频数据。 */
  audio: Uint8Array;
  /** 期望的识别语言，如 `zh`；空串表示让服务自动判断。 */
  language: string;
  /** 超时上限（毫秒）。 */
  timeoutMs: number;
  /** 外部取消信号。 */
  signal?: AbortSignal;
}

/** 转写引擎。 */
export interface AsrEngine {
  /** 引擎标识，用于日志与设置。 */
  readonly id: string;
  /**
   * 发送前的配置自检。
   * 返回问题描述数组：空数组表示配置齐全。刻意不抛异常 ——
   * "配置不完整"是要展示给用户看的状态，不是程序错误。
   */
  check(): string[];
  /**
   * 把音频转成文字。
   * @throws 网络失败、服务返回错误、超时等情况抛出带可读原因的错误。
   */
  transcribe(request: TranscribeRequest): Promise<string>;
}
