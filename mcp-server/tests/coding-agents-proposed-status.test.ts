import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// #107: dryRun false with no resolve ran a model and proposed an edit, but the status said "dry_run".

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const patch = '<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE';

async function run(extra: Record<string, unknown>) {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-status-'));
    await fs.outputFile(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
    const lp = await import('../src/tools/local-llm-patch.js');
    vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({ success: true, patch } as any);
    const sessionId = `status-${Date.now()}-${Math.random()}`;
    let r: any = await CodingAgentsHandler({ goal: 'set a to 2', workspaceRoot: ws, targetFiles: ['src/a.ts'], topKFiles: 1, sessionId, review: false, ...extra } as any);
    for (const t0 = Date.now(); r.status === 'running' && Date.now() - t0 < 60_000;) {
        await new Promise(res => setTimeout(res, 50));
        r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
    }
    return r;
}

describe('status of a run that did not apply its edit', () => {
    it('dryRun true is a dry run', async () => {
        const r = await run({ dryRun: true });
        expect(r.applied).toBe(false);
        expect(r.status).toBe('dry_run');
    }, 30000);
    it('dryRun false with no resolve is proposed, and the message says why nothing was applied', async () => {
        const r = await run({ dryRun: false });
        expect(r.applied).toBe(false);
        expect(r.status).toBe('proposed');
        expect(String(r.message ?? r.content)).toMatch(/resolve/i);
    }, 30000);
    it('dryRun false with resolve apply is applied', async () => {
        const r = await run({ dryRun: false, resolve: { action: 'apply' } });
        expect(r.applied).toBe(true);
        expect(r.status).toBe('applied');
    }, 30000);
});
