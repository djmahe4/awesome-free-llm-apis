import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class SiliconFlowProvider extends BaseProvider {
    name = 'SiliconFlow';
    id = 'siliconflow';
    baseURL = 'https://api.siliconflow.cn/v1/';
    envVar = 'SILICONFLOW_API_KEY';
    rateLimits: RateLimits = { rpm: 1000 };
    models: ProviderModel[] = [
        { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B Instruct' },
        { id: 'deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 Distill Qwen 32B' },
        { id: 'Qwen/Qwen3-8B', name: 'Qwen 3 8B' },
        { id: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B', name: 'DeepSeek R1 0528 Qwen 3 8B' },
        { id: 'THUDM/GLM-4.1V-9B-Thinking', name: 'GLM-4.1V 9B Thinking (Vision)' },
        { id: 'deepseek-ai/DeepSeek-OCR', name: 'DeepSeek OCR (Vision)' },
    ];
}
