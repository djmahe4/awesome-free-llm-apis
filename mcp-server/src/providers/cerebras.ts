import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class CerebrasProvider extends BaseProvider {
  name = 'Cerebras';
  id = 'cerebras';
  baseURL = 'https://api.cerebras.ai/v1/';
  envVar = 'CEREBRAS_API_KEY';
  rateLimits: RateLimits = { rpm: 30, rpd: 14400 };
  models: ProviderModel[] = [
    { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
    { id: 'qwen-3-235b-a22b-instruct-2507', name: 'Qwen 3 235B' },
  ];
}
