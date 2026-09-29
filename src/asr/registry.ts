/**
 * ASR 引擎注册表。
 *
 * 加一个新引擎的步骤与通道相同：实现接口 → 加进配置枚举 → 加一个分支。
 * 下一个预期成员是本地离线识别（sherpa-onnx / SenseVoice），
 * 它的价值是完全不联网、零密钥。
 */

import { OpenAiCompatibleAsr } from './http-openai.js';
import type { AsrEngine } from './types.js';
import type { VoiceDanmakuConfig } from '../config.js';

/** 已支持的引擎 id。与 config.ts 里的枚举保持一致。 */
export type AsrEngineId = VoiceDanmakuConfig['asr']['engine'];

/** 按配置构造引擎实例。 */
export function createAsrEngine(config: VoiceDanmakuConfig): AsrEngine {
  switch (config.asr.engine) {
    case 'openai-compatible':
      return new OpenAiCompatibleAsr({
        baseUrl: config.asr.baseUrl,
        model: config.asr.model,
        apiKey: config.asr.apiKey,
        language: config.asr.language
      });
    default: {
      const exhaustive: never = config.asr.engine;
      throw new Error(`未实现的识别引擎：${String(exhaustive)}`);
    }
  }
}
