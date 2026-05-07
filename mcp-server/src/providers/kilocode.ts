import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class KiloCodeProvider extends BaseProvider {
  readonly id = 'kilocode';
  readonly name = 'Kilo Code';
  readonly baseURL = 'https://api.kilo.ai/api/gateway/';
  readonly envVar = 'KILO_API_KEY';
  readonly rateLimits: RateLimits = { rpm: 3 };

  readonly models: ProviderModel[] = [
    { id: 'kilo-auto/free', name: 'Kilo Auto Free' },
  ];
}
