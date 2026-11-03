import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeSubagentValidator, parseValidatorClaims } from '../src/tools/coding-agents/subagent-validator.js';

describe('subagent-validator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const ws = '/test/workspace';
  const sid = 'session-123';
  const sampleContext = {
    goal: 'refactor authentication token verification',
    files: ['src/auth/token.ts', 'src/auth/verify.ts'],
    derived: [],
  };

  describe('parses valid JSON claims and probes', () => {
    it('parses direct JSON array format', async () => {
      const mockPayload = [
        { claim: 'token verification file exists', probe: 'file:src/auth/verify.ts' },
        { claim: 'verifyToken function is exported', probe: 'symbol:verifyToken@src/auth/verify.ts' },
      ];
      const llm = vi.fn(async () => ({
        choices: [{ message: { content: JSON.stringify(mockPayload) } }],
      }));

      const validator = makeSubagentValidator(ws, sid, llm);
      const result = await validator(sampleContext);

      expect(result).toEqual(mockPayload);
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('claim', 'token verification file exists');
      expect(result[0]).toHaveProperty('probe', 'file:src/auth/verify.ts');
    });

    it('parses JSON embedded in markdown fences and conversational text', async () => {
      const content = `Here are the skeptical assumptions:\n\`\`\`json\n[\n  {"claim": "jwt module imported", "probe": "grep:import.*jsonwebtoken@src/auth/token.ts"}\n]\n\`\`\`\nLet me know if you need more.`;
      const llm = vi.fn(async () => ({ content }));

      const validator = makeSubagentValidator(ws, sid, llm);
      const result = await validator(sampleContext);

      expect(result).toEqual([
        { claim: 'jwt module imported', probe: 'grep:import.*jsonwebtoken@src/auth/token.ts' },
      ]);
    });

    it('filters out entries without a probe string and limits output size', async () => {
      const items = [
        { claim: 'has probe', probe: 'file:a.ts' },
        { claim: 'no probe' },
        null,
        { claim: 'non-string probe', probe: 123 },
      ];
      const llm = vi.fn(async () => JSON.stringify(items));

      const validator = makeSubagentValidator(ws, sid, llm);
      const result = await validator(sampleContext);

      expect(result).toEqual([{ claim: 'has probe', probe: 'file:a.ts' }]);
    });
  });

  describe('handles bad JSON gracefully returning []', () => {
    it('returns empty array when response has malformed JSON syntax', async () => {
      const llm = vi.fn(async () => ({ choices: [{ message: { content: '[{"claim": "unclosed' } }] }));
      const validator = makeSubagentValidator(ws, sid, llm);
      const result = await validator(sampleContext);
      expect(result).toEqual([]);
    });

    it('returns empty array when response has no JSON array', async () => {
      const llm = vi.fn(async () => ({ choices: [{ message: { content: 'I cannot find any assumptions to challenge.' } }] }));
      const validator = makeSubagentValidator(ws, sid, llm);
      const result = await validator(sampleContext);
      expect(result).toEqual([]);
    });

    it('returns empty array when LLM throws an error', async () => {
      const llm = vi.fn(async () => {
        throw new Error('LLM call failed');
      });
      const validator = makeSubagentValidator(ws, sid, llm);
      const result = await validator(sampleContext);
      expect(result).toEqual([]);
    });
  });

  describe('sets adversarial role and challenge intent in prompt messages', () => {
    it('sets adversarial role, challenge intent, and temperature = 0.7', async () => {
      let capturedArgs: any = null;
      const llm = vi.fn(async (args: any) => {
        capturedArgs = args;
        return { choices: [{ message: { content: '[]' } }] };
      });

      const validator = makeSubagentValidator(ws, sid, llm);
      await validator({
        goal: 'Add oauth handler',
        files: ['src/oauth.ts'],
        derived: [{ id: 'd1', claim: 'oauth.ts exists', probe: 'file:src/oauth.ts', status: 'confirmed' } as any],
      });

      expect(capturedArgs).toBeDefined();
      expect(capturedArgs.temperature).toBe(0.7);
      expect(capturedArgs.workspace_root).toBe(ws);
      expect(capturedArgs.sessionId).toBe(sid);
      expect(capturedArgs.taskType).toBe('reasoning');

      const messages = capturedArgs.messages;
      expect(messages).toHaveLength(2);

      const systemMsg = messages.find((m: any) => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg.content.toLowerCase()).toMatch(/adversarial|skeptical/);
      expect(systemMsg.content.toLowerCase()).toMatch(/challenge/);

      const userMsg = messages.find((m: any) => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg.content.toLowerCase()).toMatch(/adversarial|challenge/);
      expect(userMsg.content).toContain('Add oauth handler');
      expect(userMsg.content).toContain('file:src/oauth.ts');
    });
  });

  describe('local model prioritization', () => {
    it('prioritizes local model first when available', async () => {
      const ollama = await import('../src/providers/ollama-local.js');
      const listSpy = vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
      const chatSpy = vi.spyOn(ollama, 'chatLocal').mockResolvedValue({
        content: JSON.stringify([{ claim: 'local claim', probe: 'file:src/local.ts' }]),
        model: 'qwen2.5-coder:7b',
        promptTokens: 10,
        completionTokens: 10,
      });

      const validator = makeSubagentValidator(ws, sid);
      const result = await validator(sampleContext);

      expect(listSpy).toHaveBeenCalled();
      expect(chatSpy).toHaveBeenCalled();
      expect(result).toEqual([{ claim: 'local claim', probe: 'file:src/local.ts' }]);
    });

    it('falls back to cloud useFreeLLM when local model fails or is unavailable', async () => {
      const ollama = await import('../src/providers/ollama-local.js');
      vi.spyOn(ollama, 'listLocalModels').mockRejectedValue(new Error('Ollama offline'));
      const freeLlm = await import('../src/tools/use-free-llm.js');
      const freeSpy = vi.spyOn(freeLlm, 'useFreeLLM').mockResolvedValue({
        choices: [{ message: { content: JSON.stringify([{ claim: 'cloud claim', probe: 'file:src/cloud.ts' }]) } }],
      } as any);

      const validator = makeSubagentValidator(ws, sid);
      const result = await validator(sampleContext);

      expect(freeSpy).toHaveBeenCalled();
      expect(result).toEqual([{ claim: 'cloud claim', probe: 'file:src/cloud.ts' }]);
    });
  });
});
