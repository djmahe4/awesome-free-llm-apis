import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('node-fetch', () => ({ default: (...a: any[]) => fetchMock(...a) }));

import { chatLocal, estimateNumCtx, isPromptTruncated } from '../src/providers/ollama-local.js';

const jsonRes = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => { fetchMock.mockReset(); delete process.env.OLLAMA_CONTEXT_LENGTH; });

describe('estimateNumCtx', () => {
  it('sizes for code at ~3 chars/token plus output headroom, min 2048, capped by the model', () => {
    const msgs = [{ role: 'user' as const, content: 'x'.repeat(30_000) }];
    expect(estimateNumCtx(msgs, 1024, 32768)).toBe(10_000 + 1024);
    expect(estimateNumCtx([{ role: 'user', content: 'hi' }], 512, 32768)).toBe(2048);
    expect(estimateNumCtx(msgs, 1024, 8192)).toBe(8192);
  });
});

describe('isPromptTruncated', () => {
  it('flags a prompt that filled (>=97% of) the context window', () => {
    expect(isPromptTruncated(8192, 8192)).toBe(true);
    expect(isPromptTruncated(7990, 8192)).toBe(true);
    expect(isPromptTruncated(4000, 8192)).toBe(false);
    expect(isPromptTruncated(0, 8192)).toBe(false);
  });
});

describe('chatLocal', () => {
  it('sends the num_ctx it used, and reports prompt truncation and output cut-off', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ model: 'm', message: { role: 'assistant', content: 'x' }, prompt_eval_count: 4096, eval_count: 10, done_reason: 'length' }));
    const r = await chatLocal('m', [{ role: 'user', content: 'hello' }], { numCtx: 4096, maxTokens: 10, temperature: 0 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toMatchObject({ num_ctx: 4096, num_predict: 10, temperature: 0 });
    expect(r.numCtx).toBe(4096);
    expect(r.promptTruncated).toBe(true);
    expect(r.outputTruncated).toBe(true);
  });

  it('a normal reply is not flagged', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ model: 'm', message: { role: 'assistant', content: 'ok' }, prompt_eval_count: 100, eval_count: 5, done_reason: 'stop' }));
    const r = await chatLocal('m', [{ role: 'user', content: 'hello' }], { numCtx: 4096 });
    expect(r.promptTruncated).toBe(false);
    expect(r.outputTruncated).toBe(false);
  });
});
