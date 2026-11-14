import { describe, it, expect } from 'vitest';
import { NvidiaProvider } from '../src/providers/nvidia.js';
import { MODEL_METADATA, isReasoningModel } from '../src/config/models.js';

const ID = 'mistralai/mistral-large-4-1t-a52b';

describe('NVIDIA mistral-large-4-1t-a52b', () => {
    it('is listed by the provider', () => {
        expect(new NvidiaProvider().models.some(m => m.id === ID)).toBe(true);
    });
    it('is registered as a vision and reasoning model with a context window', () => {
        const meta = MODEL_METADATA[ID];
        expect(meta).toBeDefined();
        expect(meta.isVision).toBe(true);
        expect(meta.isReasoning).toBe(true);
        expect(meta.contextWindow).toBeGreaterThanOrEqual(128000);
        expect(isReasoningModel(ID)).toBe(true);
    });
});
