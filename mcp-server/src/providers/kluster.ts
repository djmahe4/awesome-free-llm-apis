import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class KlusterProvider extends BaseProvider {
  name = 'Kluster AI';
  id = 'kluster';
  baseURL = 'https://api.kluster.ai/v1/';
  envVar = 'KLUSTER_API_KEY';
  rateLimits: RateLimits = {};
  models: ProviderModel[] = [
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', name: 'Llama 4 Maverick 17B' },
    { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B' },
  ];
}
