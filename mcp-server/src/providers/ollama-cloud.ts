import fetch from 'node-fetch';
import { BaseProvider } from './base.js';
import type { ChatRequest, ChatResponse, ProviderModel, RateLimits } from './types.js';

export class OllamaCloudProvider extends BaseProvider {
  name = 'Ollama Cloud';
  id = 'ollama-cloud';
  baseURL = 'https://api.ollama.com/';
  envVar = 'OLLAMA_API_KEY';
  rateLimits: RateLimits = {};
  models: ProviderModel[] = [
    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
    { id: 'qwen3.5', name: 'Qwen 3.5' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5' },
  ];

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.checkRateLimit();
    this.recordRequest();
    const apiKey = this.getApiKey();
    const url = `${this.baseURL}api/chat`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.max_tokens,
          top_p: request.top_p,
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    const data = await response.json() as {
      model: string;
      message: { role: string; content: string };
      done: boolean;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      id: `ollama-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [
        {
          index: 0,
          message: data.message,
          finish_reason: data.done ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: data.prompt_eval_count ?? 0,
        completion_tokens: data.eval_count ?? 0,
        total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
    };
  }
}
