import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class OpenRouterProvider extends BaseProvider {
  name = 'OpenRouter';
  id = 'openrouter';
  baseURL = 'https://openrouter.ai/api/v1/';
  envVar = 'OPENROUTER_API_KEY';
  rateLimits: RateLimits = { rpm: 20, rpd: 50 };
  models: ProviderModel[] = [
    { id: 'openrouter/free', name: 'OpenRouter Free Router' },
    { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots 3 Note Preview (Free)' },
    { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning (Free)' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B (Free)' },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano Omni Reasoning (Free)' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B (Free)' },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (Free)' },
    { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B (Free)' },
    { id: 'arcee-ai/trinity-large-preview:free', name: 'Trinity Large Preview (Free)' },
    { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air (Free)' },
    { id: 'arcee-ai/trinity-mini:free', name: 'Trinity Mini (Free)' },
    { id: 'mistralai/mistral-small-3.1-24b:free', name: 'Mistral Small 3.1 24B (Free)' },
    { id: 'liquid/lfm2.5-1.2b-thinking:free', name: 'LFM 2.5 1.2B Thinking (Free)' },
    { id: 'qwen/qwen3-coder-480b-a35b:free', name: 'Qwen 3 Coder 480B (Free)' },
    { id: 'meta-llama/llama-4-maverick:free', name: 'Llama 4 Maverick (Vision Free)' },
    { id: 'meta-llama/llama-4-scout:free', name: 'Llama 4 Scout (Vision Free)' },
    { id: 'poolside/laguna-s-2.1', name: 'Laguna S 2.1' },
    { id: 'nvidia/nemotron-mini-4b-instruct:free', name: 'Nemotron Mini 4B Instruct (Free)' },
    { id: 'inclusionai/ling-3.0-flash-fin:free', name: 'InclusionAI Ling 3.0 Flash Fin (Free)' },
  ];
}
