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
  ];

  get baseURL(): string {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    return `https://api.cloudflare.com/client/v4/accounts/${accountId ?? 'ACCOUNT_ID'}/ai/v1/`;
  }

  isAvailable(): boolean {
    return Boolean(process.env.CLOUDFLARE_API_TOKEN) && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
  }
}
