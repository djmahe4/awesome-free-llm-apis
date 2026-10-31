import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class OVHcloudProvider extends BaseProvider {
  readonly id = 'ovhcloud';
  readonly name = 'OVHcloud AI Endpoints';
  readonly baseURL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/';
  readonly envVar = 'OVHCLOUD_API_KEY';
  readonly rateLimits: RateLimits = { rpm: 2 }; // Free anonymous tier cap (2 RPM per IP per model)

  readonly models: ProviderModel[] = [
    { id: 'Qwen3.5-397B-A17B', name: 'Qwen 3.5 397B A17B (Vision & Reasoning)' },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B (Reasoning)' },
    { id: 'gpt-oss-20b', name: 'GPT OSS 20B (Reasoning)' },
    { id: 'Meta-Llama-3_3-70B-Instruct', name: 'Meta Llama 3.3 70B Instruct' },
    { id: 'Qwen3.8-27B', name: 'Qwen 3.8 27B (Vision & Coding)' },
    { id: 'Qwen3.6-27B', name: 'Qwen 3.6 27B (Vision)' },
    { id: 'Qwen3.5-9B', name: 'Qwen 3.5 9B (Vision)' },
    { id: 'Qwen2.5-VL-72B-Instruct', name: 'Qwen 2.5 VL 72B Instruct (Vision)' },
    { id: 'Mistral-Small-3.2-24B-Instruct-2506', name: 'Mistral Small 3.2 24B Instruct (Vision)' },
    { id: 'Mistral-Nemo-Instruct-2407', name: 'Mistral Nemo Instruct 2407' },
  ];

  /**
   * OVHcloud AI Endpoints provides a 100% free anonymous tier (2 RPM per model)
   * that requires no account or API key. If OVHCLOUD_API_KEY is unset, it remains available keyless.
   */
  override isAvailable(): boolean {
    return true;
  }

  protected override getApiKey(): string {
    return process.env[this.envVar] || '';
  }
}
