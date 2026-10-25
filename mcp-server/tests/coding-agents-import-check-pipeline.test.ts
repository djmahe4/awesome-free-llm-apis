import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.remove(ws); });

describe('pipeline: an edit importing a file that does not exist', () => {
    it('is not applied; the retry is told which import is wrong and what exists', async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-import-'));
        await fs.outputFile(path.join(ws, 'src/run.ts'), "export function run(x: number) {\n    return x;\n}\n");
        await fs.outputFile(path.join(ws, 'src/check.ts'), 'export const check = (x: number) => x > 0;\n');
        const ollama = await import('../src/providers/ollama-local.js');
        vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
        const lp = await import('../src/tools/local-llm-patch.js');
        const instructions: string[] = [];
        const replies = [
            "<<<<<<< SEARCH\nexport function run(x: number) {\n=======\nimport { check } from './chek.js';\nexport function run(x: number) {\n>>>>>>> REPLACE",
            "<<<<<<< SEARCH\nexport function run(x: number) {\n=======\nimport { check } from './check.js';\nexport function run(x: number) {\n>>>>>>> REPLACE",
        ];
        vi.spyOn(lp, 'localLlmPatch').mockImplementation(async (i: any) => {
            instructions.push(i.instruction);
            return { success: true, patch: replies.shift() ?? '' } as any;
        });
        const sessionId = `imp-${Date.now()}`;
        let r: any = await CodingAgentsHandler({ goal: 'import check from ./check.js in run.ts', workspaceRoot: ws, targetFiles: ['src/run.ts'], dryRun: false, topKFiles: 1, sessionId, review: false } as any);
        for (let i = 0; i < 200 && r.status === 'running'; i++) {
            await new Promise(res => setTimeout(res, 50));
            r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
        }
        expect(instructions[1]).toMatch(/import '\.\/chek\.js' does not exist; did you mean '\.\/check\.js'/);
        expect(r.patchPlan[0].fullPatchedContent).toContain("from './check.js'");
    }, 20000);
});
