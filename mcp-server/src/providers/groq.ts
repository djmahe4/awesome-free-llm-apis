import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class GroqProvider extends BaseProvider {
  name = 'Groq';
  id = 'groq';
  baseURL = 'https://api.groq.com/openai/v1/';
  envVar = 'GROQ_API_KEY';
  rateLimits: RateLimits = { rpm: 30, rpd: 1000 };
  models: ProviderModel[] = [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
    { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
    { id: 'qwen/qwen3-32b', name: 'Qwen 3 32B' },
  ];
}
