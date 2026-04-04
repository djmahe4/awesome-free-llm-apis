import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class NvidiaProvider extends BaseProvider {
  name = 'NVIDIA NIM';
  id = 'nvidia';
  baseURL = 'https://integrate.api.nvidia.com/v1/';
  envVar = 'NVIDIA_API_KEY';
  rateLimits: RateLimits = { rpm: 40 };
  models: ProviderModel[] = [
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
    { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2' },
    { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B' },
    { id: 'nvidia/nemotron-mini-4b-instruct', name: 'Nemotron Mini 4B' },
  ];
}
