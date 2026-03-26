import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class CohereProvider extends BaseProvider {
  name = 'Cohere';
  id = 'cohere';
  baseURL = 'https://api.cohere.com/v2/';
  envVar = 'CO_API_KEY';
  rateLimits: RateLimits = { rpm: 20, reqPerMonth: 1000 };
  models: ProviderModel[] = [
    { id: 'command-a-03-2025', name: 'Command A 03 2025' },
    { id: 'command-r-plus', name: 'Command R+' },
    { id: 'aya-expanse-32b', name: 'Aya Expanse 32B' },
  ];
}
