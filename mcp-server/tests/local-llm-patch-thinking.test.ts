import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';

vi.mock('../src/providers/ollama-local.js', async (importOriginal) => {
  const original: any = await importOriginal();
  return { ...original, listLocalModels: vi.fn(), chatLocal: vi.fn(), modelSupportsThinking: vi.fn() };
});
vi.mock('../src/pipeline/middlewares/context-gatherer.js', () => ({ ContextGatherer: { gatherContext: vi.fn().mockResolvedValue([]) } }));
vi.mock('../src/utils/ChatLogger.js', () => ({ logToolCall: vi.fn().mockResolvedValue(undefined) }));

import { listLocalModels, chatLocal, modelSupportsThinking } from '../src/providers/ollama-local.js';
import { localLlmPatch, replyBudget, THINKING_HEADROOM } from '../src/tools/local-llm-patch.js';

// Thinking stays ON by default (it can help on hard edits); the reply budget gets room for it. Only a reply
// whose reasoning still used the whole budget (empty content, cut off) is retried once with thinking off.
const SR = '<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE';
const reply = (content: string, extra: any = {}) => ({ model: 'm', content, promptTokens: 100, completionTokens: 10, numCtx: 8192, promptTruncated: false, outputTruncated: false, ...extra });

const root = path.join(os.tmpdir(), 'llp-think-' + Date.now());
const file = path.join(root, 'a.ts');
const opts = (i: number) => (chatLocal as any).mock.calls[i][2];

beforeEach(async () => {
  await fs.ensureDir(root);
  await fs.writeFile(file, 'export const a = 1;\n');
  for (const f of [listLocalModels, chatLocal, modelSupportsThinking] as any[]) f.mockReset();
  (listLocalModels as any).mockResolvedValue(['thinker:9b']);
});

describe('local_llm_patch with a thinking model', () => {
  it('keeps thinking on and adds reasoning headroom to the reply budget', async () => {
    (modelSupportsThinking as any).mockResolvedValue(true);
    (chatLocal as any).mockResolvedValue(reply(SR));
    const r: any = await localLlmPatch({ filePath: file, instruction: 'set a to 2', workspace_root: root, outputFormat: 'search-replace' } as any);
    expect(r.success).toBe(true);
    expect('think' in opts(0)).toBe(false);
    expect(opts(0).maxTokens).toBe(replyBudget(true, 'export const a = 1;\n') + THINKING_HEADROOM);
  });

  it('retries once with thinking off when the reasoning still used the whole budget', async () => {
    (modelSupportsThinking as any).mockResolvedValue(true);
    (chatLocal as any).mockResolvedValueOnce(reply('', { outputTruncated: true })).mockResolvedValueOnce(reply(SR));
    const r: any = await localLlmPatch({ filePath: file, instruction: 'set a to 2', workspace_root: root, outputFormat: 'search-replace' } as any);
    expect(r.success).toBe(true);
    expect((chatLocal as any).mock.calls.length).toBe(2);
    expect(opts(1).think).toBe(false);
    expect((chatLocal as any).mock.calls[1][0]).toBe('thinker:9b');
  });

  it("think: 'off' switches it off from the start", async () => {
    (modelSupportsThinking as any).mockResolvedValue(true);
    (chatLocal as any).mockResolvedValue(reply(SR));
    await localLlmPatch({ filePath: file, instruction: 'set a to 2', workspace_root: root, outputFormat: 'search-replace', think: 'off' } as any);
    expect(opts(0).think).toBe(false);
    expect(opts(0).maxTokens).toBe(replyBudget(true, 'export const a = 1;\n'));
  });
});

describe('local_llm_patch with a model that cannot think', () => {
  it('sends no think flag and no extra budget', async () => {
    (modelSupportsThinking as any).mockResolvedValue(false);
    (chatLocal as any).mockResolvedValue(reply(SR));
    await localLlmPatch({ filePath: file, instruction: 'set a to 2', workspace_root: root, outputFormat: 'search-replace' } as any);
    expect('think' in opts(0)).toBe(false);
    expect(opts(0).maxTokens).toBe(replyBudget(true, 'export const a = 1;\n'));
  });
});
