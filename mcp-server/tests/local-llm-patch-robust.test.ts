import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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
import { removeDir } from './helpers/temp-dir.js';

const SR = '<<<<<<< SEARCH\nexport function add(a: number, b: number) { return a + b; }\n=======\nexport function add(a: number, b: number) { return a + b; }\nexport const two = 2;\n>>>>>>> REPLACE';
const reply = (content: string, extra: any = {}) => ({ model: 'm', content, promptTokens: 100, completionTokens: 10, numCtx: 4096, promptTruncated: false, outputTruncated: false, ...extra });

describe('local_llm_patch workspace boundary', () => {
  const root = path.join(os.tmpdir(), 'llp-boundary-' + Date.now());
  afterAll(() => removeDir(root));
  const inside = path.join(root, 'ws', 'a.ts');
  const outside = path.join(root, 'secret.ts');
  beforeEach(async () => {
    await fs.ensureDir(path.join(root, 'ws'));
    await fs.writeFile(inside, 'export const a = 1;\n');
    await fs.writeFile(outside, 'export const SECRET = "do-not-send";\n');
    (listLocalModels as any).mockReset(); (chatLocal as any).mockReset();
    (listLocalModels as any).mockResolvedValue(['qwen2.5-coder:7b']);
    (chatLocal as any).mockResolvedValue(reply(SR));
  });

  it('a file outside workspace_root is refused before it is read or sent to any model', async () => {
    for (const filePath of [outside, path.join('..', 'secret.ts'), path.join(root, 'ws', '..', 'secret.ts')]) {
      const r = await localLlmPatch({ filePath, instruction: 'x', workspace_root: path.join(root, 'ws') } as any);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/outside/i);
    }
    expect(chatLocal).not.toHaveBeenCalled();
  });

  it('a relative path resolves against workspace_root, and files inside still work', async () => {
    await fs.writeFile(inside, 'export function add(a: number, b: number) { return a + b; }\n');
    const r = await localLlmPatch({ filePath: 'a.ts', instruction: 'add const two', workspace_root: path.join(root, 'ws'), outputFormat: 'search-replace' } as any);
    expect(r.error).toBeUndefined();
    expect(chatLocal).toHaveBeenCalled();
  });

  it('without workspace_root nothing changes (no boundary can be enforced)', async () => {
    const r = await localLlmPatch({ filePath: outside, instruction: 'x' } as any);
    expect(r.error ?? '').not.toMatch(/outside/i);
  });
});

describe('local_llm_patch robustness', () => {
  const dir = path.join(os.tmpdir(), 'llp-robust-' + Date.now());
  afterAll(() => removeDir(dir));
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
