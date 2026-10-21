import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';

vi.mock('../src/providers/ollama-local.js', async (importOriginal) => {
  const original: any = await importOriginal();
  return { ...original, listLocalModels: vi.fn(), chatLocal: vi.fn() };
});
vi.mock('../src/pipeline/middlewares/context-gatherer.js', () => ({ ContextGatherer: { gatherContext: vi.fn().mockResolvedValue([]) } }));
vi.mock('../src/utils/ChatLogger.js', () => ({ logToolCall: vi.fn().mockResolvedValue(undefined) }));

import { listLocalModels, chatLocal } from '../src/providers/ollama-local.js';
import { localLlmPatch } from '../src/tools/local-llm-patch.js';

const SR = '<<<<<<< SEARCH\nexport function add(a: number, b: number) { return a + b; }\n=======\nexport function add(a: number, b: number) { return a + b; }\nexport const two = 2;\n>>>>>>> REPLACE';
const reply = (content: string, extra: any = {}) => ({ model: 'm', content, promptTokens: 100, completionTokens: 10, numCtx: 4096, promptTruncated: false, outputTruncated: false, ...extra });

describe('local_llm_patch robustness', () => {
  const dir = path.join(os.tmpdir(), 'llp-robust-' + Date.now());
  const file = path.join(dir, 'a.ts');
  beforeEach(async () => {
    await fs.ensureDir(dir);
    await fs.writeFile(file, 'export function add(a: number, b: number) { return a + b; }\n');
    (listLocalModels as any).mockReset(); (chatLocal as any).mockReset();
    (listLocalModels as any).mockResolvedValue(['qwen2.5-coder:7b', 'llama3.1:8b']);
  });

  it('calls the model deterministically (temperature 0) with an explicit output budget', async () => {
    (chatLocal as any).mockResolvedValue(reply(SR));
    await localLlmPatch({ filePath: file, instruction: 'add const two', outputFormat: 'search-replace' } as any);
    const opts = (chatLocal as any).mock.calls[0][2];
    expect(opts.temperature).toBe(0);
    expect(opts.maxTokens).toBeGreaterThan(0);
  });

  it('a truncated prompt fails loudly instead of returning a patch built on a cut-off file', async () => {
    (chatLocal as any).mockResolvedValue(reply(SR, { promptTruncated: true, promptTokens: 4096 }));
    const r = await localLlmPatch({ filePath: file, instruction: 'add const two', outputFormat: 'search-replace' } as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/truncat/i);
  });

  it('a reply with zero SEARCH/REPLACE blocks is not success: the next candidate model is tried', async () => {
    (chatLocal as any)
      .mockResolvedValueOnce(reply('Sure! Here is the change you asked for.'))
      .mockResolvedValueOnce(reply(SR));
    const r = await localLlmPatch({ filePath: file, instruction: 'add const two', outputFormat: 'search-replace' } as any);
    expect(r.success).toBe(true);
    expect(r.modelUsed).toBe('llama3.1:8b');
    expect((chatLocal as any)).toHaveBeenCalledTimes(2);
  });

  it('a reply cut off mid-block (output truncated) is not success', async () => {
    (chatLocal as any).mockResolvedValue(reply('<<<<<<< SEARCH\nexport function add', { outputTruncated: true }));
    const r = await localLlmPatch({ filePath: file, instruction: 'add const two', outputFormat: 'search-replace' } as any);
    expect(r.success).toBe(false);
  });
});
