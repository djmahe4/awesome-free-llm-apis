import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class GitHubModelsProvider extends BaseProvider {
  name = 'GitHub Models';
  id = 'github-models';
  baseURL = 'https://models.inference.ai.azure.com/';
  envVar = 'GITHUB_TOKEN';
  rateLimits: RateLimits = { rpm: 15, rpd: 150 };
  models: ProviderModel[] = [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'DeepSeek-R1', name: 'DeepSeek R1' },
  ];
}
