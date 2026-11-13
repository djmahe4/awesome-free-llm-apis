import { describe, it, expect } from 'vitest';
import {
  LAYA_MODEL,
  validateThoughtDeviation,
  enforceDeviationPolicy,
  assignExpert,
  LAYA_EXPERT_SET,
  type LayaValidationResult,
  type LayaBridgeDeps,
} from '../src/harness/laya-bridge.js';
import type { ModelProfile } from '../src/services/model-router.js';

const layaProfile: ModelProfile = {
  name: LAYA_MODEL,
  capabilities: ['decision'],
  capabilitySource: 'show',
  family: 'bert',
  paramsB: 0.421,
};

const probeResponse = {
  model: LAYA_MODEL,
  answers: {
    alignment: {
      type: 'choice',
      choice: 'tangential',
      probabilities: { aligned: 0.3, tangential: 0.4, drift: 0.4 },
      confidence: 0.4,
    },
    unsafe: { type: 'noul', noul: 0.237 },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
};

type Captured = { url: string; init: any };
function mockFetch(json: unknown, ok = true) {
  const calls: Captured[] = [];
  const impl = async (url: string, init?: any) => {
    calls.push({ url, init });
    return {
      ok,
      json: async () => json,
    };
  };
  return { impl: impl as unknown as LayaBridgeDeps['fetchImpl'], calls };
}

describe('LayaBridge', () => {
  it('returns an alignment in the union when Ollama/model unavailable', async () => {
    const result = await validateThoughtDeviation({
      goal: 'analyze binary',
      trace: [{ text: 'read file' }],
      proposed: 'write to output file',
    });
    expect(['aligned', 'tangential', 'drift', 'not_available']).toContain(result.alignment);
  });

  it('posts to /v1/systemone with the router-resolved model and parses the probe wire format', async () => {
    const { impl, calls } = mockFetch(probeResponse, true);
    const result = await validateThoughtDeviation(
      {
        goal: 'analyze binary',
        trace: [{ text: 'read file' }, { text: 'list sections' }],
        proposed: 'write to output file',
      },
      { fetchImpl: impl, baseUrl: 'http://127.0.0.1:11434/', profiles: [layaProfile] },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/systemone');
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe(LAYA_MODEL);
    expect(body.questions.alignment.type).toBe('choice');
    expect(body.questions.unsafe.type).toBe('noul');
    expect(JSON.parse(body.state).goal).toBe('analyze binary');
    expect(result).toMatchObject({
      alignment: 'tangential',
      drift_prob: 0.4,
      unsafe_prob: 0.237,
    });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns not_available when the fetch fails', async () => {
    const fail = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as LayaBridgeDeps['fetchImpl'];
    const result = await validateThoughtDeviation(
      { goal: 'g', trace: [], proposed: 'p' },
      { fetchImpl: fail, baseUrl: 'http://127.0.0.1:9' },
    );
    expect(result).toEqual({
      alignment: 'not_available',
      drift_prob: 0,
      unsafe_prob: 0,
      latency_ms: 0,
    });
  });

  it('falls back to LAYA_MODEL when no profile is decision-capable and still calls the endpoint', async () => {
    const plain: ModelProfile = {
      name: 'qwen2.5-coder:7b',
      capabilities: ['completion', 'tools', 'insert'],
      capabilitySource: 'show',
      paramsB: 7.6,
    };
    const { impl, calls } = mockFetch({}, false);
    const result = await validateThoughtDeviation(
      { goal: 'g', trace: [], proposed: 'p' },
      { fetchImpl: impl, baseUrl: 'http://127.0.0.1:11434', profiles: [plain] },
    );
    expect(JSON.parse(calls[0].init.body).model).toBe(LAYA_MODEL);
    expect(result.alignment).toBe('not_available');
  });

  describe('enforceDeviationPolicy', () => {
    const r = (over: Partial<LayaValidationResult>): LayaValidationResult => ({
      alignment: 'aligned',
      drift_prob: 0.2,
      unsafe_prob: 0.2,
      latency_ms: 10,
      ...over,
    });

    it('proceeds when unavailable, halts on drift, reviews on unsafe, replans on tangential', () => {
      expect(enforceDeviationPolicy(r({ alignment: 'not_available' }))).toBe('proceed');
      expect(enforceDeviationPolicy(r({ drift_prob: 0.6 }))).toBe('halt');
      expect(enforceDeviationPolicy(r({ unsafe_prob: 0.5 }))).toBe('require_review');
      expect(enforceDeviationPolicy(r({ alignment: 'tangential', drift_prob: 0.3 }))).toBe('replan');
      expect(enforceDeviationPolicy(r({}))).toBe('proceed');
    });
  });

  describe('assignExpert', () => {
    const expertResponse = {
      model: LAYA_MODEL,
      answers: {
        expert: {
          type: 'choice',
          choice: 'reverse',
          probabilities: { reverse: 0.7, general: 0.2, coding: 0.1 },
          confidence: 0.7,
        },
      },
      usage: { input_tokens: 64, output_tokens: 0 },
    };

    it('posts a choice question to /v1/systemone and returns the laya expert', async () => {
      const { impl, calls } = mockFetch(expertResponse, true);
      const result = await assignExpert(
        { goal: 'analyze elf binary', thought: 'inspect the section headers', tool: 'reverse_tool' },
        { fetchImpl: impl, baseUrl: 'http://127.0.0.1:11434/', profiles: [layaProfile] },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/systemone');
      const body = JSON.parse(calls[0].init.body);
      expect(body.model).toBe(LAYA_MODEL);
      expect(body.questions.expert.type).toBe('choice');
      const state = JSON.parse(body.state);
      expect(state.goal).toBe('analyze elf binary');
      expect(state.thought).toBe('inspect the section headers');
      expect(state.tool).toBe('reverse_tool');
      expect(result).toMatchObject({
        expert: 'reverse',
        expert_source: 'laya',
        probabilities: { reverse: 0.7 },
        latency_ms: expect.any(Number),
      });
      expect(result.probabilities && Object.keys(result.probabilities).every(k => (LAYA_EXPERT_SET as readonly string[]).includes(k))).toBe(true);
    });

    it('truncates long thought text in the request state', async () => {
      const { impl, calls } = mockFetch(expertResponse, true);
      await assignExpert(
        { goal: 'g', thought: 'y'.repeat(800), tool: 'none' },
        { fetchImpl: impl, baseUrl: 'http://127.0.0.1:11434', profiles: [layaProfile] },
      );
      const state = JSON.parse(calls[0].init.body).state;
      expect(JSON.parse(state).thought).toHaveLength(600);
    });

    it('falls back to general/fallback when the answer is not a known expert', async () => {
      const bad = { model: LAYA_MODEL, answers: { expert: { type: 'choice', choice: 'wizard' } } };
      const { impl, calls } = mockFetch(bad, true);
      const result = await assignExpert(
        { goal: 'g', thought: 't', tool: 'browser_tool' },
        { fetchImpl: impl, baseUrl: 'http://127.0.0.1:11434', profiles: [layaProfile] },
      );
      expect(result).toMatchObject({ expert: 'general', expert_source: 'fallback' });
      expect(calls).toHaveLength(1);
    });

    it('falls back to general/fallback when the fetch fails', async () => {
      const fail = (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as LayaBridgeDeps['fetchImpl'];
      const result = await assignExpert(
        { goal: 'g', thought: 't', tool: 'none' },
        { fetchImpl: fail, baseUrl: 'http://127.0.0.1:9' },
      );
      expect(result).toEqual({
        expert: 'general',
        expert_source: 'fallback',
        probabilities: undefined,
        latency_ms: expect.any(Number),
      });
    });
  });
});
