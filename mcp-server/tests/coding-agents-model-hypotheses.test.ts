import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { parseProbe, runProbe } from '../src/tools/coding-agents/hypotheses.js';
import { runHypothesisGate } from '../src/tools/coding-agents/hypothesis-gate.js';
import { modelProposer, modelReviser } from '../src/tools/coding-agents/hypothesis-model.js';
import { loadCodingAgentsSettings } from '../src/tools/coding-agents/settings.js';

// Deferred from slice 3: cmd:/test: probes, model-proposed assumptions, and one re-plan after a refutation.
// The model is always a fake here; what is under test is that nothing it says is believed without a probe.

let ws = '';
beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'mh-'));
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.mkdir(path.join(ws, '.free-llm-mcp'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src/a.ts'), 'export function getUser(id: string) { return id; }\n');
    await fs.writeFile(path.join(ws, 'ok.js'), "require('fs').writeFileSync('ran.marker','x');console.log('fine');\n");
    await fs.writeFile(path.join(ws, 'fail.js'), "console.log('boom: expected 2 got 3');process.exit(1);\n");
});
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const ran = () => fs.access(path.join(ws, 'ran.marker')).then(() => true, () => false);
const FILES = ['src/a.ts'];
const base = { mode: 'warn' as const, goal: 'tidy `getUser`', files: FILES, get workspaceRoot() { return ws; } };

describe('cmd: and test: probes', () => {
    it('parse', () => {
        expect(parseProbe('cmd:0@node ok.js')).toEqual({ kind: 'cmd', expected: 0, command: 'node ok.js' });
        expect(parseProbe('test:npm test')).toEqual({ kind: 'test', command: 'npm test' });
        expect(parseProbe('cmd:node ok.js')).toBeNull();
        expect(parseProbe('cmd:0@')).toBeNull();
    });
    it('are open and do not run unless allowed', async () => {
        await fs.rm(path.join(ws, 'ran.marker'), { force: true });
        const r = await runProbe('cmd:0@node ok.js', ws);
        expect(r.status).toBe('open'); expect(await ran()).toBe(false);
    });
    it('confirm or refute by exit code when allowed', async () => {
        expect((await runProbe('cmd:0@node ok.js', ws, { allowExec: true })).status).toBe('confirmed');
        expect((await runProbe('cmd:1@node fail.js', ws, { allowExec: true })).status).toBe('confirmed');
        const bad = await runProbe('cmd:0@node fail.js', ws, { allowExec: true });
        expect(bad.status).toBe('refuted'); expect(bad.evidence).toMatch(/exited 1, not 0/);
        const t = await runProbe('test:node fail.js', ws, { allowExec: true });
        expect(t.status).toBe('refuted'); expect(t.evidence).toMatch(/boom/);
    });
    it('refuse commands outside the allowlist or with shell syntax', async () => {
        await fs.rm(path.join(ws, 'ran.marker'), { force: true });
        for (const p of ['cmd:0@rm -rf .', 'cmd:0@node ok.js && echo x', 'test:curl http://example.com']) {
            expect((await runProbe(p, ws, { allowExec: true })).status).toBe('refuted');
        }
        expect(await ran()).toBe(false);
    });
    it('only a person-written row in hypotheses.md runs, and only with hypothesisExec in the settings', async () => {
        const md = '| id | claim | probe | status | evidence |\n|--|--|--|--|--|\n| u1 | passes | `test:node ok.js` | open | |\n';
        await fs.writeFile(path.join(ws, 'hypotheses.md'), md);
        await fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisExec: false }));
        await fs.rm(path.join(ws, 'ran.marker'), { force: true });
        let g = await runHypothesisGate({ ...base });
        expect(g.hypotheses.find(h => h.id === 'u1')?.status).toBe('open'); expect(await ran()).toBe(false);
        await fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisExec: true }));
        g = await runHypothesisGate({ ...base });
        expect(g.hypotheses.find(h => h.id === 'u1')?.status).toBe('confirmed'); expect(await ran()).toBe(true);
        await fs.rm(path.join(ws, 'hypotheses.md'), { force: true });
        await fs.rm(path.join(ws, '.free-llm-mcp/coding-agents.json'), { force: true });
    });
    it('settings default to off', () => {
        const s = loadCodingAgentsSettings(ws);
        expect(s.hypothesisExec).toBe(false); expect(s.hypothesisModel).toBe(false);
    });
});

describe('model-proposed assumptions', () => {
    it('are checked by probe; the status the model wrote is ignored; bad ones are rejected with a reason', async () => {
        const g = await runHypothesisGate({
            ...base,
            propose: async () => [
                { claim: 'exported', probe: 'symbol:getUser@src/a.ts', status: 'refuted' },
                { claim: 'exists', probe: 'defined:fetchUser', status: 'confirmed' },
                { claim: 'vague', probe: 'grep:.*@src/a.ts' },
                { claim: 'short', probe: 'grep:a@src/a.ts' },
                { claim: 'runs', probe: 'cmd:0@node ok.js' },
                { claim: 'junk', probe: 'nonsense' },
            ],
        });
        const by = (p: string) => g.hypotheses.find(h => h.probe === p);
        expect(by('symbol:getUser@src/a.ts')?.status).toBe('confirmed');
        expect(by('defined:fetchUser')?.status).toBe('refuted');
        expect(g.rejected.map(r => r.probe)).toEqual(['grep:.*@src/a.ts', 'grep:a@src/a.ts', 'cmd:0@node ok.js', 'nonsense']);
    });
    it('a failing proposer leaves the mechanical checks', async () => {
        const g = await runHypothesisGate({ ...base, propose: async () => { throw new Error('down'); } });
        expect(g.hypotheses.map(h => h.probe)).toContain('defined:getUser');
    });
    it('the total stays capped and mechanical checks keep their place', async () => {
        const g = await runHypothesisGate({ ...base, propose: async () => Array.from({ length: 40 }, (_, i) => ({ claim: 'c', probe: `defined:name${i}x` })) });
        expect(g.hypotheses.length).toBeLessThanOrEqual(12);
        expect(g.hypotheses[0].probe).toBe('defined:getUser');
    });
});

describe('one re-plan', () => {
    const wrong = 'make `fetchUser` cache its result';
    it('a corrected goal is checked and, if it holds, the run goes on', async () => {
        const revise = vi.fn(async () => 'make `getUser` cache its result');
        const g = await runHypothesisGate({ ...base, mode: 'enforce', goal: wrong, revise });
        expect(g.blocked).toBe(false); expect(g.replanned).toBe(true); expect(g.goal).toContain('getUser'); expect(revise).toHaveBeenCalledTimes(1);
        expect(revise.mock.calls[0][0].refuted[0].probe).toBe('defined:fetchUser');
    });
    it('a second wrong goal is blocked and the model is not asked again', async () => {
        const revise = vi.fn(async () => 'make `loadUser` cache its result');
        const g = await runHypothesisGate({ ...base, mode: 'enforce', goal: wrong, revise });
        expect(g.blocked).toBe(true); expect(revise).toHaveBeenCalledTimes(1); expect(g.summary).toMatch(/loadUser/);
    });
    it('an unchanged goal or a failing reviser leaves the block', async () => {
        expect((await runHypothesisGate({ ...base, mode: 'enforce', goal: wrong, revise: async () => wrong })).blocked).toBe(true);
        expect((await runHypothesisGate({ ...base, mode: 'enforce', goal: wrong, revise: async () => { throw new Error('x'); } })).blocked).toBe(true);
    });
    it('warn and off do not spend a model call', async () => {
        const revise = vi.fn(async () => 'x');
        await runHypothesisGate({ ...base, mode: 'warn', goal: wrong, revise });
        await runHypothesisGate({ ...base, mode: 'off', goal: wrong, revise });
        expect(revise).not.toHaveBeenCalled();
    });
});

describe('model-backed proposer and reviser', () => {
    it('proposer parses a JSON array out of chatty output and drops entries without a probe', async () => {
        const llm = vi.fn(async () => ({ choices: [{ message: { content: 'Sure!\n[{"claim":"a","probe":"file:src/a.ts"},{"claim":"b"},null]' } }] }));
        const out = await modelProposer(ws, 's1', llm)({ goal: 'g', files: FILES, derived: [] });
        expect(out).toEqual([{ claim: 'a', probe: 'file:src/a.ts' }]);
        expect(JSON.stringify(llm.mock.calls[0][0].messages)).toContain('src/a.ts');
    });
    it('proposer returns nothing when the reply has no array', async () => {
        expect(await modelProposer(ws, 's1', async () => ({ content: 'no idea' }))({ goal: 'g', files: [], derived: [] })).toEqual([]);
    });
    it('reviser sends the refuted evidence and strips a code fence', async () => {
        const llm = vi.fn(async () => ({ choices: [{ message: { content: '```\nmake `getUser` cache\n```' } }] }));
        const out = await modelReviser(ws, 's1', llm)({ goal: 'make `fetchUser` cache', refuted: [{ id: 'h1', claim: 'fetchUser exists', probe: 'defined:fetchUser', status: 'refuted', evidence: 'not defined in 1 file' }] });
        expect(out).toBe('make `getUser` cache');
        expect(JSON.stringify(llm.mock.calls[0][0].messages)).toContain('not defined in 1 file');
    });
});
