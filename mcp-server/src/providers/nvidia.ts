import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class NvidiaProvider extends BaseProvider {
  name = 'NVIDIA NIM';
  id = 'nvidia';
  baseURL = 'https://integrate.api.nvidia.com/v1/';
  envVar = 'NVIDIA_API_KEY';
  rateLimits: RateLimits = { rpm: 40 };
  models: ProviderModel[] = [
    // Free Endpoint Models (Catalog & Live Preview)
    { id: 'deepseek-ai/deepseek-coder-6.7b-instruct', name: 'DeepSeek Coder 6.7B' },
    { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' },
    { id: 'z-ai/glm-5.3', name: 'GLM 5.3' },
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B' },
    { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', name: 'Nemotron 3.5 Super VL 120B' },
    { id: 'stepfun-ai/step-5-preview', name: 'Step 5 Preview' },
    { id: 'meta/muse-glimmer-30b', name: 'Muse Glimmer 30B (Vision/Reasoning)' },
    { id: 'minimaxai/minimax-m3.1-flash', name: 'MiniMax M3.1 Flash (Cyber/Reasoning)' },
    { id: 'nvidia/nemotron-3.5-bolt-e4b', name: 'Nemotron 3.5 Bolt E4B (Reasoning/Coding)' },
    { id: 'mistralai/mistral-large-4-1t-a52b', name: 'Mistral Large 4 (Vision/Reasoning)' },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano Omni (Vision/Audio)' },
    { id: 'nvidia/ising-calibration-1-35b-a3b', name: 'Ising Calibration 1 35B (Quantum VLM)' },
    { id: 'nvidia/ising-calibration-1.5-31b', name: 'Ising Calibration 1.5 31B (Quantum VLM)' },
    { id: 'nvidia/nemotron-mini-4b-instruct', name: 'Nemotron Mini 4B' },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Nemotron Super 49B' },
    { id: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1', name: 'Nemotron Nano VL 8B (Vision)' },
    { id: 'nvidia/nemotron-nano-12b-v2-vl', name: 'Nemotron Nano 12B V2 VL (Vision)' },
    { id: 'meta/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision' },
    { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision' },
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
    { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
  ];
}
