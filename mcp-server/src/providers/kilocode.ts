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
    { id: 'recursive/flint-v1.0:free', name: 'Recursive Flint 1.0' },
    { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL' },
    { id: 'xingchen-agi/xing4.0-29b-a4b:free', name: 'Xing 4.0 29B A4B' },
    { id: 'reflection/beam-free', name: 'Reflection Beam Free' },
    { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots 3 Note Preview' },
    { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning' },
    { id: 'liquid/lfm-2.5-2.6b:free', name: 'LFM 2.5 2.6B' },
    { id: 'cohere/north-mini-code:free', name: 'Cohere North Mini Code' },
    { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B' },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano Omni Reasoning' },
  ];
}
