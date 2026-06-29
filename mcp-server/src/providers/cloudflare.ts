import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class CloudflareProvider extends BaseProvider {
  name = 'Cloudflare Workers AI';
  id = 'cloudflare';
  envVar = 'CLOUDFLARE_API_TOKEN';
  rateLimits: RateLimits = {};
  models: ProviderModel[] = [
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B (Cloudflare)' },
    { id: '@cf/qwen/qwq-32b', name: 'QwQ 32B (Cloudflare)' },
    { id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B (Cloudflare)' },
    { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B (Vision)' },
    { id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B (Vision)' },
    { id: '@cf/google/gemma-3-12b-it', name: 'Gemma 3 12B (Vision)' },
    { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6 (Vision)' },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B (Vision)' },
    { id: '@cf/meta/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision' },
  ];

  get baseURL(): string {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    return `https://api.cloudflare.com/client/v4/accounts/${accountId ?? 'ACCOUNT_ID'}/ai/v1/`;
  }

  isAvailable(): boolean {
    return Boolean(process.env.CLOUDFLARE_API_TOKEN) && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
  }
}
