import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class CerebrasProvider extends BaseProvider {
  name = 'Cerebras';
  id = 'cerebras';
  baseURL = 'https://api.cerebras.ai/v1/';
  envVar = 'CEREBRAS_API_KEY';
  rateLimits: RateLimits = { rpm: 30, rpd: 14400 };
  models: ProviderModel[] = [
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'qwen3-235b', name: 'Qwen3 235B' },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
  ];
}
