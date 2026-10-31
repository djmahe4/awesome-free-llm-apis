import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { deriveHypotheses, runHypothesisGate, resolveGateMode } from '../src/tools/coding-agents/hypothesis-gate.js';
import { runProbe, parseProbe } from '../src/tools/coding-agents/hypotheses.js';
import { loadCodingAgentsSettings } from '../src/tools/coding-agents/settings.js';

// Slice 3: hypotheses are derived from the goal and plan (no model), checked before anything is edited, and the
// gate setting (off / warn / enforce) decides whether a refuted assumption stops the run.

let ws = '';
beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-'));
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src/a.ts'), 'export function getUser(id: string) { return id; }\nexport class Cart {}\n');
    await fs.writeFile(path.join(ws, 'src/b.py'), 'def apply_discount(p, d):\n    return p\n');
});
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const FILES = ['src/a.ts', 'src/b.py'];

describe('defined: probe', () => {
    it('parses', () => { expect(parseProbe('defined:getUser')).toMatchObject({ kind: 'defined', name: 'getUser' }); });
    it('finds a definition in any code file and names it', async () => {
        const r = await runProbe('defined:apply_discount', ws, { files: FILES });
        expect(r.status).toBe('confirmed'); expect(r.evidence).toMatch(/src\/b\.py:L1/);
    });
    it('refutes a name defined nowhere, saying how many files were searched', async () => {
        const r = await runProbe('defined:fetchUser', ws, { files: FILES });
        expect(r.status).toBe('refuted'); expect(r.evidence).toMatch(/2 file/);
    });
    it('refutes when there is no file list to search', async () => {
        expect((await runProbe('defined:getUser', ws)).status).toBe('refuted');
    });
});

describe('deriveHypotheses', () => {
    const derive = (goal: string, extra: Record<string, unknown> = {}) => deriveHypotheses({ goal, files: FILES, ...extra } as any);

    it('a backticked name in the goal becomes a "defined somewhere" claim', () => {
        expect(derive('make `getUser` cache results').map(h => h.probe)).toEqual(['defined:getUser']);
    });
    it('a name written as a call counts too, and trailing parentheses are dropped', () => {
        expect(derive('fix getUser() for empty ids').map(h => h.probe)).toContain('defined:getUser');
        expect(derive('fix `getUser()`').map(h => h.probe)).toEqual(['defined:getUser']);
    });
    it('a name the goal asks to create is not an assumption that it exists', () => {
        expect(derive('add a function `formatMoney` to src/a.ts')).toEqual([]);
        expect(derive('create a new class `Wallet`')).toEqual([]);
        expect(derive('implement `parseRow`')).toEqual([]);
    });
    it('each planned target file becomes an exists claim, once', () => {
        const h = derive('tidy', { targetFiles: ['src/a.ts', 'src/a.ts'], tasks: [{ id: 'task-1', task: 'x', status: 'pending', targetFile: 'src/b.py' }] });
        expect(h.map(x => x.probe)).toEqual(['file:src/a.ts', 'file:src/b.py']);
    });
    it('a target the goal says to create is not claimed to exist', () => {
        expect(derive('create src/new_module.ts with a helper', { targetFiles: ['src/new_module.ts'] })).toEqual([]);
        expect(derive('add a new file src/other.ts', { targetFiles: ['src/other.ts'] })).toEqual([]);
    });
    it('ignores keywords, short words and paths; caps the list', () => {
        expect(derive('use `if` and `ab` and `src/a.ts` and `true`')).toEqual([]);
        const many = Array.from({ length: 30 }, (_, i) => `\`name${i}\``).join(' ');
        expect(derive(`fix ${many}`).length).toBeLessThanOrEqual(12);
    });
    it('ids are h1, h2, ... and every claim names its subject', () => {
        const h = derive('fix `getUser` and `Cart`');
        expect(h.map(x => x.id)).toEqual(['h1', 'h2']);
        expect(h[0].claim).toMatch(/getUser/);
    });
});

describe('runHypothesisGate', () => {
    const base = { goal: 'make `fetchUser` cache results', workspaceRoot: '', files: FILES, targetFiles: undefined as string[] | undefined };
    const run = (mode: any, goal = base.goal, extra: any = {}) => runHypothesisGate({ ...base, workspaceRoot: ws, mode, goal, ...extra });

    it('off: does nothing', async () => {
        const g = await run('off');
        expect(g.hypotheses).toEqual([]); expect(g.blocked).toBe(false);
    });
    it('warn: reports a refuted assumption but does not block', async () => {
        const g = await run('warn');
        expect(g.refuted).toHaveLength(1); expect(g.blocked).toBe(false);
        expect(g.summary).toMatch(/assumption/i);
    });
    it('enforce: blocks on a refuted assumption and quotes the evidence', async () => {
        const g = await run('enforce');
        expect(g.blocked).toBe(true); expect(g.summary).toMatch(/fetchUser/);
    });
    it('enforce: does not block when everything holds', async () => {
        const g = await run('enforce', 'make `getUser` cache results');
        expect(g.blocked).toBe(false); expect(g.hypotheses.every(h => h.status === 'confirmed')).toBe(true);
    });
    it('enforce: an invented target file blocks', async () => {
        const g = await run('enforce', 'tidy', { targetFiles: ['src/utils/helpers.ts'] });
        expect(g.blocked).toBe(true);
    });
});

describe('gate setting', () => {
    it('defaults to warn; reads the workspace settings file; the environment can override it', async () => {
        expect(loadCodingAgentsSettings(ws).hypothesisGate).toBe('warn');
        await fs.mkdir(path.join(ws, '.free-llm-mcp'), { recursive: true });
        await fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisGate: 'enforce' }));
        expect(loadCodingAgentsSettings(ws).hypothesisGate).toBe('enforce');
        expect(resolveGateMode(ws)).toBe('enforce');
        vi.stubEnv('CODING_AGENTS_HYPOTHESIS_GATE', 'off');
        expect(resolveGateMode(ws)).toBe('off');
        vi.unstubAllEnvs();
    });
    it('an unknown value falls back to warn', async () => {
        await fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisGate: 'strict' }));
        expect(loadCodingAgentsSettings(ws).hypothesisGate).toBe('warn');
    });
});

describe('plan action and run gate through CodingAgentsHandler', () => {
    let pws = '';
    beforeAll(async () => {
        pws = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-run-'));
        await fs.mkdir(path.join(pws, 'src'), { recursive: true });
        await fs.mkdir(path.join(pws, '.free-llm-mcp'), { recursive: true });
        await fs.writeFile(path.join(pws, 'src/a.ts'), 'export function getUser(id: string) { return id; }\n');
    });
    afterAll(async () => { await fs.rm(pws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const setGate = (g: string) => fs.writeFile(path.join(pws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisGate: g }));

    it('plan writes hypotheses.md next to tasks.md and flags the refuted assumption', async () => {
        await setGate('warn');
        const { CodingAgentsHandler } = await import('../src/tools/coding-agents.js');
        const r: any = await CodingAgentsHandler({ goal: '- make `getUser` cache\n- make `fetchUser` cache', workspaceRoot: pws, action: 'plan', sessionId: 'gate-plan-1' } as any);
        expect(r.status).toBe('paused');
        expect(r.hypotheses.map((h: any) => [h.probe, h.status])).toEqual([['defined:getUser', 'confirmed'], ['defined:fetchUser', 'refuted']]);
        const md = await fs.readFile(path.join(pws, 'hypotheses.md'), 'utf-8');
        expect(md).toMatch(/\| h2 \|.*fetchUser.*\| refuted \|/);
        expect(r.diagnostics.some((d: any) => d.source === 'hypothesis' && d.severity === 'warning')).toBe(true);
        expect(r.patchSummary).toMatch(/assumption/i);
    });

    it('enforce: a run with a refuted assumption stops before editing and makes no model call', async () => {
        await setGate('enforce');
        const lp = await import('../src/tools/local-llm-patch.js');
        const spy = vi.spyOn(lp, 'localLlmPatch');
        const { CodingAgentsHandler } = await import('../src/tools/coding-agents.js');
        const before = await fs.readFile(path.join(pws, 'src/a.ts'), 'utf-8');
        let r: any = await CodingAgentsHandler({ goal: 'make `fetchUser` cache its result', workspaceRoot: pws, targetFiles: ['src/a.ts'], dryRun: false, sessionId: 'gate-run-1', review: false } as any);
        for (const t0 = Date.now(); r.status === 'running' && Date.now() - t0 < 60_000;) {
            await new Promise(res => setTimeout(res, 50));
            r = await CodingAgentsHandler({ goal: 'x', sessionId: 'gate-run-1', action: 'status' } as any);
        }
        expect(r.status).toBe('paused');
        expect(r.applied).toBe(false);
        expect(r.patchSummary).toMatch(/^Blocked before editing/);
        expect(spy).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(pws, 'src/a.ts'), 'utf-8')).toBe(before);
        spy.mockRestore();
    });
});
