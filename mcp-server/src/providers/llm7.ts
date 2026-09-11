import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class LLM7Provider extends BaseProvider {
  name = 'LLM7.io';
  id = 'llm7';
  baseURL = 'https://api.llm7.io/v1/';
  envVar = 'LLM7_API_KEY';
  rateLimits: RateLimits = { rpm: 30 };
  models: ProviderModel[] = [
    { id: 'mistral-Nemo-Instruct-2407', name: 'Mistral Nemo Instruct 2407' },
    { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
    { id: 'codestral-latest', name: 'Codestral Latest' },
    { id: 'gpt-oss:20b', name: 'GPT-OSS 20B' },
  ];
}
