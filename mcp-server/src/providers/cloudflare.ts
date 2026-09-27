import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class CloudflareProvider extends BaseProvider {
  name = 'Cloudflare Workers AI';
  id = 'cloudflare';
  envVar = 'CLOUDFLARE_API_TOKEN';
  rateLimits: RateLimits = {};
  models: ProviderModel[] = [
    // Frontier & General Text Models (Verified Free)
    { id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B (Cloudflare)' },
    { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 Distill Qwen 32B (Cloudflare)' },
    { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen 3.8 27B (Cloudflare)' },
    { id: '@cf/qwen/qwq-32b', name: 'QwQ 32B (Cloudflare)' },
    { id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B (Cloudflare)' },
    { id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen 3 30B MoE (Cloudflare)' },
    { id: '@cf/nvidia/nemotron-3-120b-a12b', name: 'Nemotron 3 120B (Cloudflare)' },
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Fast (Cloudflare)' },
    { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B (Vision)' },
    { id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B (Vision)' },
    { id: '@cf/google/gemma-3-12b-it', name: 'Gemma 3 12B (Vision)' },
    { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM 4.7 Flash (Cloudflare)' },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B (Vision)' },
    { id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B (Cloudflare)' },
    { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B (Cloudflare)' },
    { id: '@cf/meta/llama-3.2-3b-instruct', name: 'Llama 3.2 3B (Cloudflare)' },
    { id: '@cf/meta/llama-3.2-1b-instruct', name: 'Llama 3.2 1B (Cloudflare)' },
    { id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite 4.0 Micro (Cloudflare)' },
    { id: '@cf/meta/llama-guard-3-8b', name: 'Llama Guard 3 8B (Safety)' },
    { id: '@cf/aisingapore/gemma-sea-lion-v4-27b-it', name: 'Gemma SEA-LION 27B (Cloudflare)' },

    // Image Generation Models (Verified Free)
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1 Schnell (Cloudflare T2I)' },
    { id: '@cf/bytedance/stable-diffusion-xl-lightning', name: 'SDXL Lightning (Cloudflare T2I)' },
    { id: '@cf/lykon/dreamshaper-8-lcm', name: 'DreamShaper 8 LCM (Cloudflare T2I)' },
  ];

  get baseURL(): string {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    return `https://api.cloudflare.com/client/v4/accounts/${accountId ?? 'ACCOUNT_ID'}/ai/v1/`;
  }

  isAvailable(): boolean {
    return Boolean(process.env.CLOUDFLARE_API_TOKEN) && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
  }
}
