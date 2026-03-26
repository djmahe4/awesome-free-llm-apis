import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderRegistry } from '../src/providers/registry.js';

describe('ProviderRegistry', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    (ProviderRegistry as unknown as { instance: undefined }).instance = undefined;
  });

  it('getAllModels returns models from all providers', () => {
    const registry = ProviderRegistry.getInstance();
    const models = registry.getAllModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('provider');
    expect(models[0]).toHaveProperty('model');
  });

  it('isAvailable returns false when env var not set', () => {
    const registry = ProviderRegistry.getInstance();
    const cohere = registry.getProvider('cohere');
    expect(cohere).toBeDefined();
    delete process.env.CO_API_KEY;
    expect(cohere!.isAvailable()).toBe(false);
  });

  it('getProviderForModel finds correct provider', () => {
    const registry = ProviderRegistry.getInstance();
    const provider = registry.getProviderForModel('gemini-2.5-pro');
    expect(provider).toBeDefined();
    expect(provider!.id).toBe('gemini');
  });

  it('getAvailableProviders returns only providers with keys', () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    const registry = ProviderRegistry.getInstance();
    const available = registry.getAvailableProviders();
    const groq = available.find((p) => p.id === 'groq');
    expect(groq).toBeDefined();
  });
});
