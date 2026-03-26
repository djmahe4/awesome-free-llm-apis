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
    { id: 'mistral-small-latest', name: 'Mistral Small' },
    { id: 'ministral-8b-latest', name: 'Ministral 8B' },
  ];
}
