import fetch from 'node-fetch';
import type { ChatRequest, ChatResponse, Provider, ProviderModel, RateLimits } from './types.js';

export abstract class BaseProvider implements Provider {
  abstract name: string;
  abstract id: string;
  abstract baseURL: string;
  abstract models: ProviderModel[];
  abstract rateLimits: RateLimits;
  abstract envVar: string;

  private requestCountMinute = 0;
  private requestCountDay = 0;
  private minuteWindowStart = Date.now();
  private dayWindowStart = Date.now();

  isAvailable(): boolean {
    return Boolean(process.env[this.envVar]);
  }

  protected getApiKey(): string {
    const key = process.env[this.envVar];
    if (!key) throw new Error(`API key ${this.envVar} not set`);
    return key;
  }

  protected checkRateLimit(): void {
    const now = Date.now();
    if (now - this.minuteWindowStart > 60_000) {
      this.requestCountMinute = 0;
      this.minuteWindowStart = now;
    }
    if (now - this.dayWindowStart > 86_400_000) {
      this.requestCountDay = 0;
      this.dayWindowStart = now;
    }
    if (this.rateLimits.rpm && this.requestCountMinute >= this.rateLimits.rpm) {
      throw new Error(`Rate limit exceeded: ${this.rateLimits.rpm} RPM`);
    }
    if (this.rateLimits.rpd && this.requestCountDay >= this.rateLimits.rpd) {
      throw new Error(`Rate limit exceeded: ${this.rateLimits.rpd} RPD`);
    }
  }

  protected recordRequest(): void {
    this.requestCountMinute++;
    this.requestCountDay++;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.checkRateLimit();
    this.recordRequest();
    const apiKey = this.getApiKey();
    const url = `${this.baseURL}chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Origin: new URL(this.baseURL).origin,
        Referer: new URL(this.baseURL).origin + '/',
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    const json = await response.json() as ChatResponse;
    const headers: Record<string, string> = {};
    response.headers.forEach((val, key) => { headers[key] = val; });
    json._headers = headers;
    return json;
  }

  async *chatStream(request: ChatRequest): AsyncIterable<string> {
    this.checkRateLimit();
    this.recordRequest();
    const apiKey = this.getApiKey();
    const url = `${this.baseURL}chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Origin: new URL(this.baseURL).origin,
        Referer: new URL(this.baseURL).origin + '/',
      },
      body: JSON.stringify({ ...request, stream: true }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    if (!response.body) throw new Error('No response body');
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk as Buffer, { stream: true });
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    }
  }
}
