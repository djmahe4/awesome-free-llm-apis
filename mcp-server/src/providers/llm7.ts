import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class LLM7Provider extends BaseProvider {
  name = 'LLM7.io';
  id = 'llm7';
  baseURL = 'https://api.llm7.io/v1/';
  envVar = 'LLM7_API_KEY';
  rateLimits: RateLimits = { rpm: 30 };
  models: ProviderModel[] = [
    { id: 'gpt-oss-20b', name: 'GPT-OSS 20B' },
    { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', name: 'Llama 3.1 8B Turbo' },
    { id: 'codestral-latest', name: 'Codestral Latest' },
    { id: 'ministral-8b-2512', name: 'Ministral 8B 2512' },
    { id: 'GLM-4.6V-Flash', name: 'GLM-4.6V Flash' },
  ];
}
