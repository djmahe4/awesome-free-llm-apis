import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildProfile, rankProfiles, rankNamesForNeed, planTask, listModelProfiles, resetModelRouterCache,
  vramBudgetGb, type ModelProfile,
} from '../src/services/model-router.js';

// The user's real installed set (names, sizes and /api/show capabilities observed on this machine).
const tags = [
  { name: 'qwen2.5vl:3b', size: 3.2e9, details: { family: 'qwen25vl', parameter_size: '3.8B', quantization_level: 'Q4_K_M' } },
  { name: 'hf.co/empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:Q4_K_M', size: 6.5e9, details: { family: 'qwen35', parameter_size: '9B', quantization_level: 'Q4_K_M' } },
  { name: 'BGE-M3:latest', size: 1.2e9, details: { family: 'bert', parameter_size: '566.70M', quantization_level: 'F16' } },
  { name: 'qwen2.5-coder:7b', size: 4.7e9, details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } },
  { name: 'nomic-embed-text:latest', size: 0.3e9, details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' } },
];
const shows: Record<string, any> = {
  'qwen2.5vl:3b': { capabilities: ['completion', 'vision'] },
  'hf.co/empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:Q4_K_M': { capabilities: ['tools', 'thinking', 'completion', 'vision'] }, // real /api/show: the 9B qwen3.5 model is vision-capable
  'BGE-M3:latest': { capabilities: ['embedding'] },
  'qwen2.5-coder:7b': { capabilities: ['completion', 'tools', 'insert'] },
  'nomic-embed-text:latest': { capabilities: ['embedding'] },
};

function fakeOllama(opts: { showFails?: boolean } = {}) {
  return async (url: string, init?: any) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: tags }) };
    if (url.endsWith('/api/show')) {
      if (opts.showFails) throw new Error('show unavailable');
      const model = JSON.parse(init.body).model;
      return { ok: true, json: async () => shows[model] ?? {} };
    }
    return { ok: false, json: async () => ({}) };
  };
}

const profile = (name: string, extra: Partial<ModelProfile> = {}): ModelProfile => ({
  name, capabilities: ['completion'], capabilitySource: 'show', ...extra,
});

beforeEach(() => { resetModelRouterCache(); delete process.env.OLLAMA_VRAM_BUDGET_GB; });

describe('discovery on the real installed set', () => {
  it('reads real capabilities from /api/show and sizes from /api/tags', async () => {
    const ps = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: async () => null });
    const byName = Object.fromEntries(ps.map(p => [p.name, p]));
    expect(byName['qwen2.5vl:3b'].capabilities).toContain('vision');
    expect(byName['qwen2.5-coder:7b'].capabilities).toEqual(['completion', 'tools', 'insert']);
    expect(byName['BGE-M3:latest'].capabilities).toEqual(['embedding']);
    expect(byName['qwen2.5-coder:7b']).toMatchObject({ capabilitySource: 'show', paramsB: 7.6, memorySource: 'size' });
    expect(byName['BGE-M3:latest'].paramsB).toBeCloseTo(0.567, 2);
  });

  it('a screenshot-to-code task uses the vision model to look and the coder to implement', async () => {
    const ps = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: async () => null });
    const plan = planTask(ps, { hasImages: true, kind: 'code' });
    expect(plan.missing).toEqual([]);
    expect(plan.stages.map(s => [s.stage, s.model])).toEqual([
      ['describe-images', 'qwen2.5vl:3b'],
      ['implement', 'qwen2.5-coder:7b'],
    ]);
  });

  it('plain code, general and embedding tasks each get a fitting model; the 6.5 GB model never wins under the 6 GB budget', async () => {
    const ps = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: async () => null });
    expect(planTask(ps, { kind: 'code' }).stages[0].model).toBe('qwen2.5-coder:7b');
    const general = planTask(ps, { kind: 'general' }).stages[0].model;
    expect(general).not.toContain('Qwythos');
    expect(['qwen2.5-coder:7b', 'qwen2.5vl:3b']).toContain(general);
    expect(['BGE-M3:latest', 'nomic-embed-text:latest']).toContain(planTask(ps, { kind: 'embedding' }).stages[0].model);
    // never an embedding model for chat
    for (const kind of ['code', 'general'] as const) {
      expect(planTask(ps, { kind }).stages[0].model).not.toMatch(/bge|nomic/i);
    }
  });

  it('the 6.5 GB vision-capable model is excluded from vision work at 6 GB, and becomes the best vision model at 8 GB', async () => {
    const ps0 = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: async () => null });
    expect(planTask(ps0, { hasImages: true, kind: 'code' }).stages[0].model).toBe('qwen2.5vl:3b');
    process.env.OLLAMA_VRAM_BUDGET_GB = '8';
    const ps1 = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: async () => null });
    expect(planTask(ps1, { hasImages: true, kind: 'code' }).stages[0].model).toContain('Qwythos');
  });

  it('raising the budget to 8 GB makes the 6.5 GB reasoning model eligible', async () => {
    process.env.OLLAMA_VRAM_BUDGET_GB = '8';
    expect(vramBudgetGb()).toBe(8);
    const ps = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: async () => null });
    const ranked = rankProfiles(ps, 'general');
    expect(ranked.find(r => r.name.includes('Qwythos'))!.fitsBudget).toBe(true);
    expect(ranked[0].name).toContain('Qwythos');
  });
});

describe('conditions', () => {
  it('no vision model installed: image task reports vision as missing but still plans the code stage', () => {
    const plan = planTask([profile('qwen2.5-coder:7b', { memoryGb: 5 })], { hasImages: true, kind: 'code' });
    expect(plan.missing).toEqual(['vision']);
    expect(plan.stages[0]).toMatchObject({ stage: 'describe-images', model: null });
    expect(plan.stages[1].model).toBe('qwen2.5-coder:7b');
  });

  it('only over-budget models installed: nothing is chosen and the need is reported', () => {
    const plan = planTask([profile('big-coder:34b', { memoryGb: 21, paramsB: 34 })], { kind: 'code' });
    expect(plan.stages[0].model).toBeNull();
    expect(plan.missing).toEqual(['code']);
    expect(plan.stages[0].reason).toMatch(/budget/);
  });

  it('empty installation: every need is missing', () => {
    expect(planTask([], { hasImages: true, kind: 'code' }).missing).toEqual(['vision', 'code']);
    expect(planTask([], { kind: 'embedding' }).missing).toEqual(['embedding']);
  });

  it('only embedding models installed: chat needs are missing rather than served by an embedder', () => {
    const plan = planTask([profile('nomic-embed-text', { capabilities: ['embedding'] })], { kind: 'code' });
    expect(plan.missing).toEqual(['code']);
  });

  it('llmfit memory beats the size estimate in both directions', () => {
    const fits = profile('a-coder:7b', { sizeGb: 7, memoryGb: 4.1, memorySource: 'llmfit' });
    const tooBig = profile('b-coder:7b', { sizeGb: 3, memoryGb: 9, memorySource: 'llmfit' });
    const r = rankProfiles([tooBig, fits], 'code');
    expect(r[0].name).toBe('a-coder:7b');
    expect(r.find(x => x.name === 'b-coder:7b')!.fitsBudget).toBe(false);
  });

  it('a vision model that is also code-named serves both stages of an image task', () => {
    const vlCoder = profile('qwen-coder-vl:7b', { capabilities: ['completion', 'vision'], memoryGb: 5.5, paramsB: 7 });
    const plan = planTask([vlCoder], { hasImages: true, kind: 'code' });
    expect(plan.stages.map(s => s.model)).toEqual(['qwen-coder-vl:7b', 'qwen-coder-vl:7b']);
  });

  it('prefers the larger model that still fits the budget', () => {
    const small = profile('x-coder:3b', { paramsB: 3, memoryGb: 2.3 });
    const mid = profile('y-coder:7b', { paramsB: 7, memoryGb: 4.9 });
    const big = profile('z-coder:14b', { paramsB: 14, memoryGb: 9.5 });
    expect(rankProfiles([small, big, mid], 'code').map(r => r.name)).toEqual(['y-coder:7b', 'x-coder:3b', 'z-coder:14b']);
  });

  it('when /api/show is unavailable, capabilities are guessed from the name and labelled as a guess', async () => {
    const ps = await listModelProfiles({ fetchImpl: fakeOllama({ showFails: true }), llmfitInfo: async () => null });
    const vl = ps.find(p => p.name === 'qwen2.5vl:3b')!;
    expect(vl.capabilitySource).toBe('name');
    expect(vl.capabilities).toContain('vision');
    expect(ps.find(p => p.name === 'BGE-M3:latest')!.capabilities).toEqual(['embedding']);
    expect(rankProfiles(ps, 'code')[0].reason).toContain('guessed');
  });

  it('a throwing or hanging llmfit hook never breaks discovery', async () => {
    const boom = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: async () => { throw new Error('llmfit missing'); } });
    expect(boom).toHaveLength(5);
    const hang = await listModelProfiles({ fetchImpl: fakeOllama(), llmfitInfo: () => new Promise(() => {}) });
    expect(hang).toHaveLength(5);
  }, 20000);

  it('llmfit context and fit label are used when it answers; the installed size stays the memory truth', async () => {
    const ps = await listModelProfiles({
      fetchImpl: fakeOllama(),
      llmfitInfo: async (n) => (n === 'qwen2.5-coder:7b' ? { name: n, memoryRequiredGb: 4.4, contextLength: 32768, fitLevel: 'good' } : null),
    });
    expect(ps.find(p => p.name === 'qwen2.5-coder:7b')).toMatchObject({ memoryGb: 5.4, memorySource: 'size', contextLength: 32768, fitLevel: 'good' });
  });

  it('llmfit memory is used only when the installed size is unknown', async () => {
    const noSize = async (url: string, init?: any) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'mystery:7b' }] }) };
      return { ok: true, json: async () => ({ capabilities: ['completion'] }) };
    };
    const ps = await listModelProfiles({ fetchImpl: noSize, llmfitInfo: async (n) => ({ name: n, memoryRequiredGb: 4.4 }) });
    expect(ps[0]).toMatchObject({ memoryGb: 4.4, memorySource: 'llmfit' });
  });

  it('an unreachable Ollama surfaces as an error, not an empty plan', async () => {
    await expect(listModelProfiles({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) })).rejects.toThrow(/api\/tags/);
  });
});

describe('rankNamesForNeed (names-only callers)', () => {
  it('keeps coder-first ordering and sinks embedding models without dropping them', () => {
    const ranked = rankNamesForNeed(['nomic-embed-text', 'llama3.1:8b', 'qwen2.5-coder:7b', 'mistral:7b'], 'code');
    expect(ranked[0]).toBe('qwen2.5-coder:7b');
    expect(ranked[ranked.length - 1]).toBe('nomic-embed-text');
    expect(ranked).toHaveLength(4);
  });

  it('buildProfile recognises vision and embedding names without any API call', () => {
    expect(buildProfile('llava:7b').capabilities).toContain('vision');
    expect(buildProfile('mxbai-embed-large').capabilities).toEqual(['embedding']);
    expect(buildProfile('devstral-small:24b').capabilities).toEqual(['completion']);
  });
});
