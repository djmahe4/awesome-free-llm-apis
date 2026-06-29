import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class ModelScopeProvider extends BaseProvider {
  name = 'ModelScope';
  id = 'modelscope';
  baseURL = 'https://api-inference.modelscope.cn/v1/';
  envVar = 'MODELSCOPE_API_KEY';
  rateLimits: RateLimits = { rpd: 2000 };
  models: ProviderModel[] = [
    { id: 'zai-org/GLM-5.2', name: 'GLM 5.2 (753B)' },
    { id: 'zai-org/GLM-5.1', name: 'GLM 5.1 (753B)' },
    { id: 'zai-org/GLM-5', name: 'GLM 5 (753B)' },
    { id: 'zai-org/GLM-4.7-Flash', name: 'GLM 4.7 Flash (31B)' },
    { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro (861B)' },
    { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash (158B)' },
    { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2 (685B)' },
    { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', name: 'Qwen3 Coder 30B' },
    { id: 'Qwen/Qwen3-8B', name: 'Qwen3 8B' },
    { id: 'stepfun-ai/Step-3.5-Flash', name: 'Step 3.5 Flash (199B)' },
    { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5 397B (Vision)' },
    { id: 'Qwen/Qwen3-VL-235B-A22B-Instruct', name: 'Qwen3 VL 235B (Vision)' },
  ];
}
