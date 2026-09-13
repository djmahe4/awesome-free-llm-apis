import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class MistralProvider extends BaseProvider {
  name = 'Mistral AI';
  id = 'mistral';
  baseURL = 'https://api.mistral.ai/v1/';
  envVar = 'MISTRAL_API_KEY';
  rateLimits: RateLimits = { rps: 1, tokensPerMonth: 1_000_000_000 };
  models: ProviderModel[] = [
    { id: 'mistral-large-latest', name: 'Mistral Large' },
    { id: 'mistral-medium-latest', name: 'Mistral Medium' },
    { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5' },
    { id: 'mistral-small-latest', name: 'Mistral Small' },
    { id: 'open-mistral-nemo', name: 'Mistral Nemotron' },
    { id: 'ministral-8b-latest', name: 'Ministral 8B' },
    { id: 'ministral-8b-2512', name: 'Ministral 3 8B' },
    { id: 'ministral-3b-2512', name: 'Ministral 3 3B' },
    { id: 'ministral-14b-2512', name: 'Ministral 3 14B' },
  ];
}
