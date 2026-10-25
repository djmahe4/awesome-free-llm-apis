import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// Audit P1: when the local model failed, coding_agents silently sent the file and goal to free cloud
// providers (traced: "cloud search-replace fallback"), although local_llm_patch promises local-only.
// Cloud fallback is now opt-in: input allowCloudFallback, or .free-llm-mcp/coding-agents.json.

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.remove(ws); });

async function run(extra: Record<string, unknown> = {}, settings?: object) {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-cloud-'));
    await fs.outputFile(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
    if (settings) await fs.outputFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify(settings));
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
    const lp = await import('../src/tools/local-llm-patch.js');
    vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({ success: false, error: 'local model produced nothing usable' } as any);
    const cloud = await import('../src/tools/use-free-llm.js');
    const cloudSpy = vi.spyOn(cloud, 'useFreeLLM').mockResolvedValue({ choices: [{ message: { content: '' } }] } as any);
    cloudSpy.mockClear(); // a second spyOn in the same test returns the same spy
    const sessionId = `cloud-${Date.now()}-${Math.random()}`;
    let r: any = await CodingAgentsHandler({ goal: 'set a to 2', workspaceRoot: ws, targetFiles: ['src/a.ts'], dryRun: false, topKFiles: 1, sessionId, review: false, ...extra } as any);
    for (let i = 0; i < 200 && r.status === 'running'; i++) {
        await new Promise(res => setTimeout(res, 50));
        r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
    }
    return { r, cloudCalls: cloudSpy.mock.calls.length };
}

describe('cloud fallback is opt-in', () => {
    it('by default no code is sent to a cloud model, and the diagnostic says how to allow it', async () => {
        const { r, cloudCalls } = await run();
        expect(cloudCalls).toBe(0);
        expect(JSON.stringify(r.diagnostics)).toMatch(/cloud fallback is off/i);
        expect(JSON.stringify(r.diagnostics)).toMatch(/allowCloudFallback/);
    }, 20000);

    it('allowCloudFallback: true on the call enables it', async () => {
        const { cloudCalls } = await run({ allowCloudFallback: true });
        expect(cloudCalls).toBeGreaterThan(0);
    }, 20000);

    it('the workspace setting enables it too, and the call can still switch it off', async () => {
        expect((await run({}, { allowCloudFallback: true })).cloudCalls).toBeGreaterThan(0);
        expect((await run({ allowCloudFallback: false }, { allowCloudFallback: true })).cloudCalls).toBe(0);
    }, 30000);
});
