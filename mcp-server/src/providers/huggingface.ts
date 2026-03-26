import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class HuggingFaceProvider extends BaseProvider {
  name = 'Hugging Face';
  id = 'huggingface';
  baseURL = 'https://router.huggingface.co/v1/';
  envVar = 'HF_TOKEN';
  rateLimits: RateLimits = {};
  models: ProviderModel[] = [
    { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B' },
    { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B v0.3' },
  ];
}
