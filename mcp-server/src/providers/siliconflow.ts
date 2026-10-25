import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class SiliconFlowProvider extends BaseProvider {
    name = 'SiliconFlow';
    id = 'siliconflow';
    // SILICONFLOW_BASE_URL selects the region: international keys only work on https://api.siliconflow.com/v1/
    baseURL = (process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/?$/, '/');
    envVar = 'SILICONFLOW_API_KEY';
    rateLimits: RateLimits = { rpm: 1000 };
    models: ProviderModel[] = [
        { id: 'XingChenAGI/Xing4.0-29B', name: 'Xing 4.0 29B' },
        { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B Instruct' },
        { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen 2.5 7B Instruct' },
        { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    ];
}
