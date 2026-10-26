import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { codeEditCandidates } from '../src/tools/local-llm-patch.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// A caller must be able to pick the local model (e.g. a bigger one for a cross-file change). Before this,
// both the pipeline and local_llm_patch chose by themselves, so the 7B coder always won.

const INSTALLED = ['qwen2.5-coder:7b', 'hf.co/empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:Q4_K_M', 'qwen2.5vl:3b'];
const QWYTHOS = INSTALLED[1];

describe('codeEditCandidates with a pinned model', () => {
    it('puts the pinned model first and keeps the rest as fallbacks', () => {
        const c = codeEditCandidates(INSTALLED, QWYTHOS);
        expect(c[0]).toBe(QWYTHOS);
        expect(c).toContain('qwen2.5-coder:7b');
        expect(c).not.toContain('qwen2.5vl:3b');
    });

    it('a short name matches its installed tag', () => {
        expect(codeEditCandidates(['qwen2.5-coder:7b', 'other:1b'], 'qwen2.5-coder')[0]).toBe('qwen2.5-coder:7b');
    });

    it('a pinned model that is not installed is ignored, not invented', () => {
        expect(codeEditCandidates(INSTALLED, 'nope:70b')).not.toContain('nope:70b');
    });
});

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('coding_agents model input', () => {
    it('passes the pinned model down to local_llm_patch and reports it as used', async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-pin-'));
        await fs.ensureDir(path.join(ws, 'src'));
        await fs.writeFile(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
        const ollama = await import('../src/providers/ollama-local.js');
        vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(INSTALLED);
        const lp = await import('../src/tools/local-llm-patch.js');
        const seen: Array<string | undefined> = [];
        vi.spyOn(lp, 'localLlmPatch').mockImplementation(async (i: any) => {
            seen.push(i.model);
            return { success: true, patch: '<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE', modelUsed: i.model } as any;
        });
        const sessionId = `pin-${Date.now()}`;
        let r: any = await CodingAgentsHandler({ goal: 'set a to 2', workspaceRoot: ws, targetFiles: ['src/a.ts'], dryRun: false, topKFiles: 1, sessionId, review: false, model: QWYTHOS } as any);
        for (let i = 0; i < 200 && r.status === 'running'; i++) {
            await new Promise(res => setTimeout(res, 50));
            r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
        }
        expect(seen[0]).toBe(QWYTHOS);
        expect(r.modelUsed).toBe(QWYTHOS);
    }, 20000);
});
