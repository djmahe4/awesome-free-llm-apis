import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class GeminiProvider extends BaseProvider {
  name = 'Google Gemini';
  id = 'gemini';
  baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  envVar = 'GEMINI_API_KEY';
  rateLimits: RateLimits = { rpm: 15, rpd: 1000 };
  models: ProviderModel[] = [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
  ];
}
