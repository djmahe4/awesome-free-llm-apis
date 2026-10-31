import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// The whole run: settings turn the model layer on, a goal names a function that does not exist, the (fake) model
// corrects it once, and the run goes on with the corrected goal instead of stopping.

const calls: string[] = [];
vi.mock('../src/tools/use-free-llm.js', () => ({
    useFreeLLM: vi.fn(async (req: any) => {
        const text = JSON.stringify(req.messages);
        calls.push(text.includes('Rewrite the goal') ? 'revise' : text.includes('factual assumptions') ? 'propose' : 'other');
        if (text.includes('Rewrite the goal')) return { choices: [{ message: { content: 'make `getUser` cache its result' } }] };
        if (text.includes('factual assumptions')) return { choices: [{ message: { content: '[{"claim":"getUser is in src/a.ts","probe":"symbol:getUser@src/a.ts"}]' } }] };
        return { choices: [{ message: { content: '' } }] };
    }),
}));

let ws = '';
beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'replan-'));
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.mkdir(path.join(ws, '.free-llm-mcp'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src/a.ts'), 'export function getUser(id: string) { return id; }\n');
});
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

async function finish(first: any) {
    const { CodingAgentsHandler } = await import('../src/tools/coding-agents.js');
    let r = first;
    for (const t0 = Date.now(); r.status === 'running' && Date.now() - t0 < 60_000;) {
        await new Promise(res => setTimeout(res, 50));
        r = await CodingAgentsHandler({ goal: 'x', sessionId: first.sessionId ?? 'replan-1', action: 'status' } as any);
    }
    return r;
}

describe('coding_agents with hypothesisModel on', () => {
    it('enforce: a refuted goal is corrected once and the run is not blocked', async () => {
        await fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisGate: 'enforce', hypothesisModel: true }));
        const { CodingAgentsHandler } = await import('../src/tools/coding-agents.js');
        const r: any = await finish(await CodingAgentsHandler({ goal: 'make `fetchUser` cache its result', workspaceRoot: ws, targetFiles: ['src/a.ts'], dryRun: true, sessionId: 'replan-1', review: false } as any));
        expect(r.patchSummary ?? '').not.toMatch(/^Blocked before editing/);
        expect(r.replannedGoal).toBe('make `getUser` cache its result');
        expect(calls.filter(c => c === 'revise')).toHaveLength(1);
        expect(calls).toContain('propose');
        const md = await fs.readFile(path.join(ws, 'hypotheses.md'), 'utf-8');
        expect(md).toMatch(/getUser/);
    });

    it('with the setting off, no model call is made for the gate', async () => {
        calls.length = 0;
        await fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisGate: 'enforce' }));
        const { CodingAgentsHandler } = await import('../src/tools/coding-agents.js');
        const r: any = await finish(await CodingAgentsHandler({ goal: 'make `fetchUser` cache its result', workspaceRoot: ws, targetFiles: ['src/a.ts'], dryRun: true, sessionId: 'replan-2', review: false } as any));
        expect(r.patchSummary).toMatch(/^Blocked before editing/);
        expect(calls.filter(c => c === 'revise' || c === 'propose')).toEqual([]);
    });
});
