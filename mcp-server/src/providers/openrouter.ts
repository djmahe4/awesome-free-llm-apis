import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class OpenRouterProvider extends BaseProvider {
  name = 'OpenRouter';
  id = 'openrouter';
  baseURL = 'https://openrouter.ai/api/v1/';
  envVar = 'OPENROUTER_API_KEY';
  rateLimits: RateLimits = { rpm: 20, rpd: 50 };
  models: ProviderModel[] = [
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (Free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)' },
    { id: 'openai/gpt-4o-mini:free', name: 'GPT-4o Mini (Free)' },
  ];
}
