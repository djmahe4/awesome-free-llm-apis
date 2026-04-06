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
    { id: 'stepfun/step-3.5-flash:free', name: 'Step 3.5 Flash' },
    { id: 'nvidia/nemotron-mini-4b-instruct:free', name: 'Nemotron Mini 4B Instruct' },
    { id: 'arcee-ai/trinity-large-preview:free', name: 'Trinity Large Preview' },
    { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air' },
    { id: 'arcee-ai/trinity-mini:free', name: 'Trinity Mini' },
    { id: 'qwen/qwen3-coder-480b-a35b-instruct:free', name: 'Qwen 3 Coder 480B' },
    { id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'Qwen 3 Next 80B' },
    { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct' },
    { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B' },
    { id: 'mistralai/mistral-small-3.1-24b:free', name: 'Mistral Small 3.1 24B' },
    { id: 'liquid/lfm2.5-1.2b-thinking:free', name: 'LFM 2.5 1.2B Thinking' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B' },
    { id: 'nvidia/nemotron-nano-12b-v2-vl:free', name: 'Nemotron Nano 12B VL' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano 30B' },
    { id: 'nvidia/nemotron-nano-9b-v2:free', name: 'Nemotron Nano 9B' },
  ];
}
