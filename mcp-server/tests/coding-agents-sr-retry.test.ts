import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// Traced live (CODING_AGENTS_TRACE=1): a 6-line edit to a 618-line file cost ~150 s per attempt, because
// one unusable SEARCH/REPLACE reply (~5 s) sent the pipeline straight to regenerating the whole file
// (7,573 output tokens, ~125 s). A second SEARCH/REPLACE call that is told why the first failed costs
// another ~5 s; regenerating a large file is both the slowest and the riskiest strategy.

const BIG = [
    'export function target(x: number) {',
    '    const y = x + 1;',
    '    return y;',
    '}',
    ...Array.from({ length: 400 }, (_, i) => `export const filler${i} = ${i};`),
].join('\n') + '\n';

const goodBlock = '<<<<<<< SEARCH\n    const y = x + 1;\n=======\n    const y = x + 2;\n>>>>>>> REPLACE\n';
const badBlock = '<<<<<<< SEARCH\n    const nothingLikeThis = 0;\n=======\n    const y = x + 2;\n>>>>>>> REPLACE\n';

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.remove(ws); });

async function run(replies: Array<{ success: boolean; patch?: string; error?: string }>) {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-sr-retry-'));
    await fs.ensureDir(path.join(ws, 'src'));
    await fs.writeFile(path.join(ws, 'src/big.ts'), BIG);
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
    const lp = await import('../src/tools/local-llm-patch.js');
    const calls: Array<{ format?: string; instruction: string }> = [];
    vi.spyOn(lp, 'localLlmPatch').mockImplementation(async (i: any) => {
        calls.push({ format: i.outputFormat, instruction: i.instruction });
        const next = replies.shift() ?? { success: false, error: 'no more scripted replies' };
        return next as any;
    });
    const sessionId = `sr-retry-${Date.now()}`;
    let r: any = await CodingAgentsHandler({ goal: 'in target, change x + 1 to x + 2', workspaceRoot: ws, targetFiles: ['src/big.ts'], dryRun: false, topKFiles: 1, sessionId, review: false });
    for (let i = 0; i < 200 && r.status === 'running'; i++) {
        await new Promise(res => setTimeout(res, 50));
        r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
    }
    return { r, calls };
}

describe('SEARCH/REPLACE gets one informed retry before anything slower', () => {
    it('a block that does not match is retried as SEARCH/REPLACE with the reason, and the retry is used', async () => {
        const { r, calls } = await run([{ success: true, patch: badBlock }, { success: true, patch: goodBlock }]);
        expect(calls.map(c => c.format)).toEqual(["search-replace", "search-replace"]);
        expect(calls[1].instruction).toMatch(/previous SEARCH\/REPLACE reply could not be used/i);
        expect(calls[1].instruction).toMatch(/not found/i);
        expect(r.patchPlan[0].fullPatchedContent).toContain('const y = x + 2;');
    }, 20000);

    it('a large file is never regenerated whole when SEARCH/REPLACE fails twice', async () => {
        const { r, calls } = await run([{ success: true, patch: badBlock }, { success: true, patch: badBlock }]);
        expect(calls.every(c => c.format === 'search-replace')).toBe(true);
        expect(calls).toHaveLength(2);
        const msg = JSON.stringify(r.diagnostics);
        expect(msg).toMatch(/not found/i);
    }, 20000);
});
