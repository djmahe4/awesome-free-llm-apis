import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class SiliconFlowProvider extends BaseProvider {
    name = 'SiliconFlow';
    id = 'siliconflow';
    baseURL = 'https://api.siliconflow.cn/v1/';
    envVar = 'SILICONFLOW_API_KEY';
    rateLimits: RateLimits = { rpm: 1000 };
    models: ProviderModel[] = [
        { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen 2.5 7B Instruct' },
        { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', name: 'DeepSeek R1 Distill Qwen 7B' },
        { id: 'Pro/zai-org/GLM-4.7', name: 'GLM 4.7 Thinking/Vision' },
        { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    ];
}
