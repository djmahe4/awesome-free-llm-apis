import { describe, it, expect } from 'vitest';
import { classifyFailure, FailureLedger } from '../src/utils/provider-failures.js';

// #142, #144: a retired model ID must not open the circuit for its whole provider, and a provider that answers
// 401 or 402 must not cost a request in every run.

describe('classifyFailure', () => {
    it('a 400, 404 or 410 that names the model is a gone model', () => {
        expect(classifyFailure(400, 'qwen/qwen3-coder-480b-a35b:free is not a valid model ID')).toBe('model_gone');
        expect(classifyFailure(404, 'This model is unavailable for free. The paid version is available now')).toBe('model_gone');
        expect(classifyFailure(410, "The model 'qwen/x' has reached its end of life on 2026-06-11")).toBe('model_gone');
    });
    it('a 400 that does not name a model is not a gone model', () => {
        expect(classifyFailure(400, 'invalid JSON in request body')).toBe('other');
        expect(classifyFailure(400, "This model's maximum context length is 8192 tokens")).toBe('other');
        expect(classifyFailure(400, 'string is too long for this model')).toBe('other');
    });
    it('401, 402 and 403 are auth problems', () => {
        expect(classifyFailure(401, 'Please bind your Alibaba Cloud account before use')).toBe('auth');
        expect(classifyFailure(402, '')).toBe('auth');
        expect(classifyFailure(403, 'forbidden')).toBe('auth');
    });
    it('429 is a rate limit', () => {
        expect(classifyFailure(429, 'slow down')).toBe('rate');
    });
    it('5xx and a missing status are server problems', () => {
        expect(classifyFailure(500, '')).toBe('server');
        expect(classifyFailure(502, 'bad gateway')).toBe('server');
        expect(classifyFailure(undefined, 'socket hang up')).toBe('server');
    });
});

describe('FailureLedger', () => {
    const T0 = 1_000_000;
    const HOUR = 3_600_000;

    it('a gone model is disabled for a day and leaves the provider alone', () => {
        const l = new FailureLedger();
        expect(l.record('openrouter', 'qwen/dead:free', 400, 'qwen/dead:free is not a valid model ID', T0)).toBe('model_gone');
        expect(l.isModelDisabled('openrouter', 'qwen/dead:free', T0 + 1000)).toBe(true);
        expect(l.isModelDisabled('openrouter', 'qwen/dead:free', T0 + 23 * HOUR)).toBe(true);
        expect(l.isModelDisabled('openrouter', 'qwen/dead:free', T0 + 25 * HOUR)).toBe(false);
        expect(l.isModelDisabled('openrouter', 'nvidia/nemotron-3.5-lightning:free', T0 + 1000)).toBe(false);
        expect(l.isProviderBlocked('openrouter', T0 + 1000)).toBe(false);
    });
    it('the same model on another provider is not disabled', () => {
        const l = new FailureLedger();
        l.record('openrouter', 'm', 404, 'model not found', T0);
        expect(l.isModelDisabled('nvidia', 'm', T0 + 1)).toBe(false);
    });
    it('one auth failure blocks the provider for thirty minutes', () => {
        const l = new FailureLedger();
        expect(l.record('modelscope', 'deepseek', 401, 'bind your account', T0)).toBe('auth');
        expect(l.isProviderBlocked('modelscope', T0 + 29 * 60_000)).toBe(true);
        expect(l.isProviderBlocked('modelscope', T0 + 31 * 60_000)).toBe(false);
    });
    it('rate limits and server errors change nothing here', () => {
        const l = new FailureLedger();
        expect(l.record('llm7', 'm', 429, '', T0)).toBe('rate');
        expect(l.record('cloudflare', 'm', 500, '', T0)).toBe('server');
        expect(l.isProviderBlocked('llm7', T0 + 1)).toBe(false);
        expect(l.isModelDisabled('cloudflare', 'm', T0 + 1)).toBe(false);
    });
    it('a success clears an auth block', () => {
        const l = new FailureLedger();
        l.record('huggingface', 'm', 402, '', T0);
        l.recordSuccess('huggingface');
        expect(l.isProviderBlocked('huggingface', T0 + 1)).toBe(false);
    });
});
