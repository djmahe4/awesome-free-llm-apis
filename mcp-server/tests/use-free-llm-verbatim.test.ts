import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFreeLLM } from '../src/tools/use-free-llm.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { getSharedResponseCache } from '../src/pipeline/instances.js';

// Issue #124: code coming back from a provider lost the blank line after a closing brace
// ("}\n\n  // x" arrived as "}  // x"). The reply content must be returned as the provider sent it.

vi.mock('../src/utils/debounce.js', () => ({
    debounce: vi.fn((fn: any) => { const d = (...args: any[]) => fn(...args); d.flush = () => {}; return d; }),
}));

const SNIPPET = 'function a() {\n  if (x) {\n    y();\n  }\n\n  // second part\n  z();\n}\n\nexport function b() {\n  return 1;\n}\n';

describe('useFreeLLM returns the reply as the provider sent it', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('GROQ_API_KEY', 'test-key-long-enough');
        (ProviderRegistry as unknown as { instance: undefined }).instance = undefined;
        getSharedResponseCache().clear();
    });

    async function reply(content: string, extra: Record<string, unknown> = {}) {
        const groq = ProviderRegistry.getInstance().getProvider('groq');
        if (!groq) throw new Error('groq provider missing');
        vi.spyOn(groq, 'chat').mockResolvedValue({
            id: 'verbatim-test', object: 'chat.completion', created: Date.now(), model: 'llama-3.3-70b-versatile',
            choices: [{ index: 0, message: { role: 'assistant' as const, content }, finish_reason: 'stop' }],
        });
        const res = await useFreeLLM({
            model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'echo this exactly: ' + Math.random() }],
            workspace_root: process.cwd(), ...extra,
        } as never);
        return String(res.choices[0].message.content);
    }

    it('keeps the blank line after a closing brace (plain call)', async () => {
        expect(await reply(SNIPPET)).toBe(SNIPPET.trim());
    });
    it('keeps it for a one-pass coding call, the way coding_agents asks', async () => {
        expect(await reply(SNIPPET, { taskType: 'coding', isOnePass: true, skipIndexing: true })).toBe(SNIPPET.trim());
    });
    it('keeps blank lines after other characters too', async () => {
        const text = 'const a = 1;\n\nconst b = 2;\n\n// end\n';
        expect(await reply(text)).toBe(text.trim());
    });
});
