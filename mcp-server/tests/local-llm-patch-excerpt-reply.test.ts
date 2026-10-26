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

const FILE = "import { a } from './a.js';\n\nexport function run(x: number) {\n    const y = a(x);\n    return y;\n}\n";
const reply = (content: string) => ({ model: 'm', content, promptTokens: 100, completionTokens: 10, numCtx: 4096, promptTruncated: false, outputTruncated: false });

describe('local_llm_patch: an edited-excerpt reply to a SEARCH/REPLACE request', () => {
  const root = path.join(os.tmpdir(), 'llp-excerpt-' + Date.now());
  afterAll(() => removeDir(root));
  const file = path.join(root, 'run.ts');
  beforeEach(async () => {
    await fs.ensureDir(root);
    await fs.writeFile(file, FILE);
    (listLocalModels as any).mockReset(); (chatLocal as any).mockReset();
    (listLocalModels as any).mockResolvedValue(['qwen2.5vl:3b', 'qwen2.5-coder:7b']);
  });

  it('is converted into SEARCH/REPLACE blocks from the first model, with no fallback model called', async () => {
    const edited = FILE.replace('    return y;', '    if (y < 0) return 0;\n    return y;');
    (chatLocal as any).mockResolvedValue(reply('```diff\n' + edited.trimEnd() + '\n```'));
    const r: any = await localLlmPatch({ filePath: file, instruction: 'clamp negatives', workspace_root: root, outputFormat: 'search-replace' } as any);
    expect(r.success).toBe(true);
    expect(r.patch).toMatch(/<<<<<<< SEARCH[\s\S]*if \(y < 0\) return 0;[\s\S]*>>>>>>> REPLACE/);
    expect((chatLocal as any).mock.calls.length).toBe(1);
    expect((chatLocal as any).mock.calls[0][0]).toBe('qwen2.5-coder:7b');
  });
});
