import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class PollinationsProvider extends BaseProvider {
  name = 'Pollinations AI';
  id = 'pollinations';
  baseURL = 'https://gen.pollinations.ai/v1/';
  envVar = 'POLLINATIONS_API_KEY';
  rateLimits: RateLimits = { rpm: 60 };

  // Models cataloged from official + community 0-pollen/low-cost endpoints
  models: ProviderModel[] = [
    // Free Official Models
    { id: 'black-forest-labs/flux.1-schnell', name: 'FLUX.1 Schnell (Fast T2I)' },
    { id: 'tongyi-mai/z-image-turbo', name: 'Z-Image Turbo' },
    { id: 'lykon/dreamshaper-8-lcm', name: 'DreamShaper 8 LCM (Ultra Low Cost)' },
    { id: 'hexgrad/kokoro-82m', name: 'Kokoro 82M TTS (54 Voices)' },
    { id: 'qwen/qwen3-tts-flash', name: 'Qwen 3 TTS Flash' },
    { id: 'alibaba/wan-2.2-fast', name: 'Wan 2.2 Fast (480p Video)' },

    // Verified Fast Text Generation Models
    { id: 'qwen/qwen3.8-flash', name: 'Qwen 3.8 Flash (1M Ctx Fast Coder/Reasoning)' },
    { id: 'poolside/laguna-s-2.1', name: 'Laguna S 2.1 (1M Ctx Coder)' },
    { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B (Multimodal Coder/Vision)' },
    { id: 'google/gemini-2.5-flash-lite:search', name: 'Gemini 2.5 Flash Lite Search (Web Search)' },
    { id: 'meta/llama-4-scout', name: 'Llama 4 Scout (131K General Chat/Vision)' },
    { id: 'qwen/qwen3.7-flash', name: 'Qwen 3.7 Flash (1M Ultra-cheap Generalist)' },
    { id: 'inclusionai/ling-3.0-flash-vl', name: 'Ling 3.0 Flash VL (Vision & Video MoE)' },
    { id: 'mistralai/mistral-small-3.2', name: 'Mistral Small 3.2 (128K Fast Chat)' },
    { id: 'openai/gpt-5.4-nano', name: 'GPT-5.4 Nano (Fast Chat/Classification)' },

    // Free Community Zero-Cost Routes (Verified Active)
    { id: 'community/AkshayCoder48/stepfun-step-3.7-flash-free', name: 'StepFun Step 3.7 Flash (Community Free)' },
    { id: 'community/AkshayCoder48/grok-4-fast', name: 'Grok 4 Fast (Community Free)' },
    { id: 'community/AkshayCoder48/cohere-north-mini-code:free', name: 'Cohere North Mini Code (Community Free)' },
    { id: 'community/AkshayCoder48/kilo-auto-free', name: 'Kilo Auto Free (Community Router)' },
    { id: 'community/AkshayCoder48/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite (Community Free)' },
    { id: 'community/AkshayCoder48/gemini-2.5-flash', name: 'Gemini 2.5 Flash (Community Free)' },
    { id: 'community/AkshayCoder48/nvidia-nemotron-3-super-120b-a12b-free', name: 'Nemotron 3 Super 120B (Community Free)' },
    { id: 'community/MarcosFRG/flux-1-schnell', name: 'FLUX.1 Schnell (Community Micro-Cost)' }
  ];

}
