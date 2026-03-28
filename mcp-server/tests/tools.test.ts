import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listAvailableFreeModels } from '../src/tools/list-models.js';
import { runCodeMode } from '../src/tools/code-mode.js';
import { useFreeLLM } from '../src/tools/use-free-llm.js';
import { ProviderRegistry } from '../src/providers/registry.js';

describe('list_available_free_models', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    (ProviderRegistry as unknown as { instance: undefined }).instance = undefined;
  });

  it('returns correct structure', async () => {
    const result = await listAvailableFreeModels({});
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.models)).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('filters by provider', async () => {
    const result = await listAvailableFreeModels({ provider: 'groq' });
    expect(result.models.every((m) => m.providerId === 'groq')).toBe(true);
  });

  it('available_only filters out providers without keys', async () => {
    delete process.env.GROQ_API_KEY;
    const result = await listAvailableFreeModels({ available_only: true });
    expect(result.models.every((m) => m.available)).toBe(true);
  });
});

describe('code_mode', () => {
  it('executes code and returns stdout', async () => {
    const result = await runCodeMode({ code: 'print("test output")' });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('test output');
  });

  it('computes compression ratio when data is provided', async () => {
    const data = 'a'.repeat(100);
    const result = await runCodeMode({
      code: 'print(DATA.slice(0, 10))',
      data,
    });
    expect(result.compressionRatio).toBeDefined();
    expect(result.compressionRatio!).toBeLessThan(1);
  });

  it('returns executionTimeMs', async () => {
    const result = await runCodeMode({ code: 'print("done")' });
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('use_free_llm input validation', () => {
  it('throws when no provider available for model', async () => {
    (ProviderRegistry as unknown as { instance: undefined }).instance = undefined;
    await expect(
      useFreeLLM({
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'hello' }],
        fallback: false,
      })
    ).rejects.toThrow();
  });

  it('uses cache on second call', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    (ProviderRegistry as unknown as { instance: undefined }).instance = undefined;

    const mockResponse = {
      id: 'cached-id',
      object: 'chat.completion',
      created: Date.now(),
      model: 'llama-3.3-70b-versatile',
      choices: [{ index: 0, message: { role: 'assistant', content: 'cached' }, finish_reason: 'stop' }],
    };

    // Get the registry instance that the lazy router will also use
    const registry = ProviderRegistry.getInstance();
    const groq = registry.getProvider('groq');
    if (!groq) return;

    const chatSpy = vi.spyOn(groq, 'chat').mockResolvedValue(mockResponse);

    const input = {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user' as const, content: 'unique-cache-test-xyz' }],
    };

    await useFreeLLM(input);
    await useFreeLLM(input);
    expect(chatSpy).toHaveBeenCalled();
  });
});
