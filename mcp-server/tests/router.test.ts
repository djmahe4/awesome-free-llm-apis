import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/router/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';

describe('Router', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    (ProviderRegistry as unknown as { instance: undefined }).instance = undefined;
  });

  it('route() finds provider for known model', () => {
    const router = new Router();
    const provider = router.route('gemini-3.1-pro-preview');
    expect(provider).toBeDefined();
    expect(provider.id).toBe('gemini');
  });

  it('route() throws for unknown model', () => {
    const router = new Router();
    expect(() => router.route('nonexistent-model-xyz')).toThrow();
  });

  it('route() uses specified provider override', () => {
    const router = new Router();
    const provider = router.route('gemini-3.1-flash-preview', 'gemini');
    expect(provider.id).toBe('gemini');
  });

  it('routeWithFallback retries on failure', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    vi.stubEnv('CEREBRAS_API_KEY', 'test-key');
    (ProviderRegistry as unknown as { instance: undefined }).instance = undefined;
    const router = new Router();

    const registry = ProviderRegistry.getInstance();
    const groq = registry.getProvider('groq');
    if (!groq) return;

    const mockResponse = {
      id: 'test-id',
      object: 'chat.completion',
      created: Date.now(),
      model: 'llama-3.3-70b-versatile',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    };

    vi.spyOn(groq, 'chat').mockRejectedValueOnce(new Error('rate limit'));

    const cerebras = registry.getProvider('cerebras');
    if (!cerebras) return;
    vi.spyOn(cerebras, 'chat').mockResolvedValueOnce(mockResponse);

    const response = await router.routeWithFallback(
      'llama-3.3-70b-versatile',
      { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] },
      ['llama3.1-8b']
    );
    expect(response).toBeDefined();
  });
});
