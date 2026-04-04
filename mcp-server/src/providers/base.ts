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

  private consecutiveFailures = 0;
  private cooldownUntil = 0;

  getPenaltyScore(): number {
    if (Date.now() < this.cooldownUntil) {
      return 0.5; // Temporarily reduce score by 50%
    }
    return 0;
  }

  recordFailure(status: number): void {
    this.consecutiveFailures++;
    // If rate limited, cooldown for 60 seconds
    if (status === 429) {
      this.cooldownUntil = Date.now() + 60_000;
    } else if (status >= 500) {
      // Exponential backoff for server errors, capped at 60s
      const penaltyMs = Math.min(10_000 * Math.pow(2, this.consecutiveFailures - 1), 60_000);
      this.cooldownUntil = Date.now() + penaltyMs;
    }
  }

  isAvailable(): boolean {
    const key = process.env[this.envVar];
    if (!key || key.trim() === '') return false;

    const lowerKey = key.toLowerCase();
    // Professional placeholder detection
    const placeholders = [
      'your_', 'insert_', 'token_here', 'key_here', 'example',
      'sk-insert', 'ghp_insert', 'gsk_insert', 'ai_insert'
    ];

    if (placeholders.some(p => lowerKey.includes(p))) {
      return false;
    }

    // Check for "min length" logic - most real keys are > 15 chars
    // except for maybe very short ones, but 10 is a safe bet for modern APIs
    if (key.trim().length < 10) {
      return false;
    }

    return true;
  }

  getUsageStats(): { requestCountMinute: number; requestCountDay: number } {
    this.checkRateLimit();
    return {
      requestCountMinute: this.requestCountMinute,
      requestCountDay: this.requestCountDay
    };
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

    // Log warnings if local limits are exceeded, but don't hard-block.
    // This allows the Intelligent Router to still factor this into scoring
    // while permitting fallback attempts to reach the actual API.
    if (this.rateLimits.rpm && this.requestCountMinute >= this.rateLimits.rpm) {
      console.warn(`[${this.name}] Local RPM limit reached (${this.requestCountMinute}/${this.rateLimits.rpm}). Proceeding with best-effort attempt.`);
    }
    if (this.rateLimits.rpd && this.requestCountDay >= this.rateLimits.rpd) {
      console.warn(`[${this.name}] Local RPD limit reached (${this.requestCountDay}/${this.rateLimits.rpd}). Proceeding with best-effort attempt.`);
    }
  }

  protected recordRequest(): void {
    this.requestCountMinute++;
    this.requestCountDay++;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.checkRateLimit();
    const apiKey = this.getApiKey();
    const url = `${this.baseURL}chat/completions`;

    // Sanitize request: Remove internal-only fields that strict APIs reject
    const { agentic, ...sanitizedRequest } = request as any;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Origin: new URL(this.baseURL).origin,
        Referer: new URL(this.baseURL).origin + '/',
      },
      body: JSON.stringify(sanitizedRequest),
    });
    if (!response.ok) {
      const text = await response.text();
      const error: any = new Error(`HTTP ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.recordRequest();
    const json = await response.json() as ChatResponse;
    const headers: Record<string, string> = {};
    response.headers.forEach((val, key) => { headers[key] = val; });
    json._headers = headers;
    return json;
  }

  async *chatStream(request: ChatRequest): AsyncIterable<string> {
    this.checkRateLimit();
    const apiKey = this.getApiKey();
    const url = `${this.baseURL}chat/completions`;

    // Sanitize request: Remove internal-only fields that strict APIs reject
    const { agentic, ...sanitizedRequest } = request as any;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Origin: new URL(this.baseURL).origin,
        Referer: new URL(this.baseURL).origin + '/',
      },
      body: JSON.stringify({ ...sanitizedRequest, stream: true }),
    });
    if (!response.ok) {
      const text = await response.text();
      const error: any = new Error(`HTTP ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.recordRequest();
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
