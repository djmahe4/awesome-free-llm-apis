import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class GonkaProvider extends BaseProvider {
  readonly id = 'gonka';
  readonly name = 'Gonka Broker';
  readonly baseURL = 'https://proxy.gonkabroker.com/v1/';
  readonly envVar = 'GONKA_API_KEY';
  readonly rateLimits: RateLimits = { rpm: 6 }; // Free tier rate limit (6 RPM enforced by gateway)

  readonly models: ProviderModel[] = [
    { id: 'zai-org/GLM-5.3-Flash', name: 'GLM 5.3 Flash (400K Reasoning)' },
    { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7 (200K Reasoning)' },
    { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash (400K Reasoning)' },
  ];
}
