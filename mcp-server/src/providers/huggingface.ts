import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class HuggingFaceProvider extends BaseProvider {
  name = 'Hugging Face';
  id = 'huggingface';
  baseURL = 'https://router.huggingface.co/v1/';
  envVar = 'HF_TOKEN';
  // v1.0.6: Hugging Face is no longer treated as unlimited-free in routing.
  // Track as credit-based ($0.10 monthly credits) so routers can deprioritize it.
  rateLimits: RateLimits = { reqPerMonth: 1 };
  models: ProviderModel[] = [
    { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'google/gemma-3-27b-it', name: 'Gemma 3 27B' },
    { id: 'google/gemma-4-31B-it', name: 'Gemma 4 31B' },
    { id: 'google/gemma-4-26B-A4B-it', name: 'Gemma 4 26B' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B v0.3' },
  ];
}
