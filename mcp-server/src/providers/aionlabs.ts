import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class AionLabsProvider extends BaseProvider {
  name = 'AionLabs';
  id = 'aionlabs';
  baseURL = 'https://api.aionlabs.ai/v1/';
  envVar = 'AIONLABS_API_KEY';
  rateLimits: RateLimits = { rpm: 60 };

  // Storytelling and roleplaying models cataloged directly from https://api.aionlabs.ai/v1/models
  models: ProviderModel[] = [
    {
      id: 'aion-labs/aion-3.5',
      name: 'AionLabs: Aion 3.5 (Flagship Storytelling & Roleplaying)',
      capabilities: ['roleplaying']
    },
    {
      id: 'aion-labs/aion-3.5-mini',
      name: 'AionLabs: Aion 3.5 Mini (Fast Storytelling & Roleplaying)',
      capabilities: ['roleplaying']
    },
    {
      id: 'aion-labs/aion-3.0',
      name: 'AionLabs: Aion 3.0 (GLM Collaborative Narrative)',
      capabilities: ['roleplaying']
    },
    {
      id: 'aion-labs/aion-3.0-mini',
      name: 'AionLabs: Aion 3.0 Mini (DeepSeek Collaborative Narrative)',
      capabilities: ['roleplaying']
    },
    {
      id: 'aion-labs/aion-2.0',
      name: 'AionLabs: Aion 2.0 (DeepSeek V3.2 Roleplay & Tension)',
      capabilities: ['roleplaying']
    },
    {
      id: 'aion-labs/aion-rp-llama-3.1-8b',
      name: 'AionLabs: Aion-RP 1.0 8B (Llama 3.1 Roleplaying)',
      capabilities: ['roleplaying']
    }
  ];
}
