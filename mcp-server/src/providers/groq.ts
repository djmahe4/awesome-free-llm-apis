import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class GroqProvider extends BaseProvider {
  name = 'Groq';
  id = 'groq';
  baseURL = 'https://api.groq.com/openai/v1/';
  envVar = 'GROQ_API_KEY';
  rateLimits: RateLimits = { rpm: 30, rpd: 1000 };
  models: ProviderModel[] = [
    { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
    { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
    { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B' },
  ];
}
