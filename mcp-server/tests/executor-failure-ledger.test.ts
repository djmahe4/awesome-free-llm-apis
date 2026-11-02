import { describe, it, expect, vi, beforeAll } from 'vitest';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';

vi.mock('../src/utils/PersistenceManager.js', () => ({
    persistence: {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue({ providers: {} }),
    }
}));

beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

// #142, #144 as the executor sees them.
describe('LLMExecutor failure handling', () => {
    it('a retired model ID disables that model and does not open the provider circuit', () => {
        const ex = new LLMExecutor();
        ex.recordProviderFailure('openrouter', 400, 'qwen/dead:free is not a valid model ID', 'qwen/dead:free');
        ex.recordProviderFailure('openrouter', 400, 'qwen/dead:free is not a valid model ID', 'qwen/dead:free');
        expect(ex.isProviderCircuitOpen('openrouter')).toBe(false);
        expect(ex.isModelDisabled('openrouter', 'qwen/dead:free')).toBe(true);
        expect(ex.isModelDisabled('openrouter', 'nvidia/nemotron-3.5-lightning:free')).toBe(false);
    });
    it('one 401 blocks the provider', () => {
        const ex = new LLMExecutor();
        ex.recordProviderFailure('modelscope', 401, 'Please bind your Alibaba Cloud account before use', 'deepseek-ai/x');
        expect(ex.isProviderCircuitOpen('modelscope')).toBe(true);
    });
    it('a success lifts the block', () => {
        const ex = new LLMExecutor();
        ex.recordProviderFailure('huggingface', 402, '', 'm');
        ex.recordProviderSuccess('huggingface');
        expect(ex.isProviderCircuitOpen('huggingface')).toBe(false);
    });
    it('rate limits and server errors still open the circuit after two failures', () => {
        const ex = new LLMExecutor();
        ex.recordProviderFailure('llm7', 429);
        expect(ex.isProviderCircuitOpen('llm7')).toBe(false);
        ex.recordProviderFailure('llm7', 429);
        expect(ex.isProviderCircuitOpen('llm7')).toBe(true);
    });
});
