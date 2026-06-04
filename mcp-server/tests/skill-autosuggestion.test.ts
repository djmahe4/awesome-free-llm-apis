import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFreeLLM } from '../src/tools/use-free-llm.js';
import { loadSkillPrompt } from '../src/tools/load-skill-prompt.js';

import { ProviderRegistry } from '../src/providers/registry.js';

vi.mock('../src/tools/load-skill-prompt.js', () => ({
  loadSkillPrompt: vi.fn().mockResolvedValue({ success: true, skills: [{ name: 'tdd-workflow', description: 'Test-Driven Development' }] }),
}));

// Mock ProviderRegistry
vi.mock('../src/providers/registry.js', () => {
  const mockProvider = {
    id: 'mock-provider',
    models: [{ id: 'mock-model' }],
    chat: vi.fn().mockResolvedValue({
      id: 'mock-id',
      object: 'chat.completion',
      created: Date.now(),
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'mock reply' }, finish_reason: 'stop' }],
    }),
    consecutiveFailures: 0,
    getUsageStats: () => ({ requestCountMinute: 0 }),
    rateLimits: { rpm: 60 }
  };
  return {
    ProviderRegistry: {
      getInstance: vi.fn().mockReturnValue({
        getAvailableProviders: () => [mockProvider],
        getProvider: () => mockProvider
      })
    }
  };
});

describe('Skill Autosuggestion and Input Wrapping Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('use_free_llm accepts prompt:string and wraps to message history', async () => {
    const input = {
      prompt: 'Verify current project files',
      agentic: false,
    };
    
    // We should be able to run useFreeLLM with prompt instead of messages
    const response = await useFreeLLM(input as any);
    expect(response).toBeDefined();
    expect(response.choices?.[0]?.message?.content).toBeDefined();
  });

  it('suggestedSkills tail appendage is present on final response and triggers search', async () => {
    const input = {
      prompt: 'Implement a new feature',
      agentic: true,
      sessionId: 'test-skill-suggestion',
    };

    const response = await useFreeLLM(input as any);
    const finalChoice = response.choices?.[0]?.message;
    if (finalChoice && (finalChoice as any)._suggestedPromise) {
      await (finalChoice as any)._suggestedPromise;
    }
    const content = finalChoice?.content || '';
    expect(content).toContain('💡 Suggested Skills');
    expect(loadSkillPrompt).toHaveBeenCalled();
  });
});
