import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// #147 end to end: an edit that removes a declaration the goal does not name is not written, and the next attempt is told why.

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const FILE = 'export const keepMe = 1;\nexport const other = 2;\n';
const reply = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

async function run(goal: string, patch: string) {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-symbol-'));
    await fs.outputFile(path.join(ws, 'src/a.ts'), FILE);
    await fs.outputFile(path.join(ws, 't.cjs'), 'process.exit(0);\n');
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
    const lp = await import('../src/tools/local-llm-patch.js');
    const spy = vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({ success: true, patch } as any);
    const sessionId = `symbol-${Date.now()}-${Math.random()}`;
    let r: any = await CodingAgentsHandler({ goal, workspaceRoot: ws, targetFiles: ['src/a.ts'], dryRun: false, topKFiles: 1, sessionId, resolve: { action: 'apply' }, maxRepairAttempts: 1, samples: 1, review: false } as any);
    for (const t0 = Date.now(); r.status === 'running' && Date.now() - t0 < 60_000;) {
        await new Promise(res => setTimeout(res, 50));
        r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
    }
    return { r, instructions: spy.mock.calls.map(c => String((c[0] as any).instruction)), written: await fs.readFile(path.join(ws, 'src/a.ts'), 'utf8') };
}

describe('the symbol-loss gate', () => {
    it('keeps the file, reports the name, and tells the next attempt', async () => {
        const { r, instructions, written } = await run('Add a constant added', reply('export const keepMe = 1;', 'export const added = 3;'));
        expect(written).toBe(FILE);
        expect(JSON.stringify(r.diagnostics)).toContain('keepMe');
        expect(instructions.length).toBeGreaterThan(1);
        // The add-only guard refuses the reply, so the full-file fallback runs and drops `other` on attempt 1; either name proves the brief.
        expect(instructions[instructions.length - 1]).toMatch(/Your last edit removed (?:keepMe|other)/);
        expect(r.repair?.outcome).not.toBe('converged');
    }, 30000);
    it('lets an edit through when the goal names the removed declaration', async () => {
        const { written } = await run('Replace keepMe with added', reply('export const keepMe = 1;', 'export const added = 3;'));
        expect(written).toContain('export const added = 3;');
        expect(written).not.toContain('keepMe');
    }, 30000);
    it('lets an ordinary edit through', async () => {
        const { written } = await run('Add a constant added', reply('export const other = 2;', 'export const other = 2;\nexport const added = 3;'));
        expect(written).toContain('export const added = 3;');
        expect(written).toContain('keepMe');
    }, 30000);
});
