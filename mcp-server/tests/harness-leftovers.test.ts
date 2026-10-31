import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { agentHarness } from '../src/tools/agent-harness.js';
import { HarnessStore } from '../src/harness/store.js';
import { assertWorkspaceRootAllowed } from '../src/harness/policy.js';

// H12-H16 leftovers: approvals listing for a run whose declaration vanished, input validation on deploy, an
// opt-in server-wide workspace boundary, a silent no-op resume, and approvals that could be used any number of times.

let ws = '';
beforeEach(async () => { ws = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-left-')); });
afterEach(async () => { delete process.env.HARNESS_RESTRICT_ROOTS; await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const baseRun = (over: Record<string, unknown> = {}): any => ({
    runId: 'r1', harness: 'x', declarationName: 'no-such-declaration', goal: 'g', workspaceRoot: ws, status: 'paused_approval',
    budget: { maxTokens: 1000, used: 0, reserved: 0, toolCalls: 0 }, createdAt: Date.now(), updatedAt: Date.now(), ...over,
});

describe('H12: approvals listing', () => {
    it('still lists approvals when the run\'s declaration can no longer be loaded', async () => {
        const store = new HarnessStore('r1', ws);
        await store.saveRun(baseRun());
        await store.createApproval({ runId: 'r1', callId: 'c', role: 'dev', tool: 'cyber_tool', args: {}, argsHash: 'h', reason: 'needs a human' });
        const r: any = await agentHarness({ action: 'approvals', runId: 'r1', workspace_root: ws });
        expect(r.approvals).toHaveLength(1);
        expect(r.warning).toMatch(/declaration/i);
    });
});

describe('H12: deploy input validation', () => {
    it.each([
        ['goal is not text', { goal: 42 }],
        ['goal is blank', { goal: '   ' }],
        ['goal is huge', { goal: 'x'.repeat(20_001) }],
        ['maxTokens is negative', { goal: 'ok', maxTokens: -5 }],
        ['maxTokens is not a number', { goal: 'ok', maxTokens: 'lots' }],
        ['harness is not text', { goal: 'ok', harness: { a: 1 } }],
    ])('rejects a deploy where %s, before touching disk', async (_n, extra) => {
        await expect(agentHarness({ action: 'deploy', workspace_root: ws, ...extra } as any)).rejects.toThrow(/goal|maxTokens|harness/i);
        await expect(fs.readdir(path.join(ws, '.free-llm-mcp', 'harness'))).rejects.toThrow();
    });
});

describe('H13: workspace boundary without a per-declaration list', () => {
    const decl: any = { harness: { name: 'd' } };
    it('is unrestricted by default (unchanged)', () => {
        expect(() => assertWorkspaceRootAllowed(decl, path.join(os.tmpdir(), 'anywhere'))).not.toThrow();
    });
    it('HARNESS_RESTRICT_ROOTS=1 limits it to the server working directory and WORKSPACE_ROOTS', () => {
        process.env.HARNESS_RESTRICT_ROOTS = '1';
        expect(() => assertWorkspaceRootAllowed(decl, process.cwd())).not.toThrow();
        expect(() => assertWorkspaceRootAllowed(decl, path.join(os.tmpdir(), 'anywhere-else'))).toThrow(/not permitted|allowed roots/i);
    });
});

describe('H14: resuming a run that is still waiting on a monitored process', () => {
    it('says that nothing changed instead of returning the run as if it advanced', async () => {
        const store = new HarnessStore('r2', ws);
        await store.saveRun(baseRun({ runId: 'r2', declarationName: 'research-analysis', status: 'monitoring', pendingMonitor: { monitorId: 'm-live', role: 'dev', stepIndex: 0 } }));
        const { MonitorRegistry } = await import('../src/harness/monitor.js');
        const spy = MonitorRegistry.get;
        (MonitorRegistry as any).get = (id: string) => (id === 'm-live' ? { status: 'running' } : spy.call(MonitorRegistry, id));
        try {
            const r: any = await agentHarness({ action: 'resume', runId: 'r2', workspace_root: ws });
            expect(r.run.status).toBe('monitoring');
            expect(r.note).toMatch(/still waiting/i);
        } finally { (MonitorRegistry as any).get = spy; }
    });
});

describe('H15: an approval is single-use', () => {
    it('authorises one execution of the exact call; the next needs a new approval', async () => {
        const store = new HarnessStore('r3', ws);
        await store.saveRun(baseRun({ runId: 'r3' }));
        const req = await store.createApproval({ runId: 'r3', callId: 'c1', role: 'dev', tool: 'cyber_tool', args: {}, argsHash: 'h1', reason: 'r' });
        await store.decideApproval(req.id, true, 'user');
        expect((await store.consumeApproval('r3', 'c1', 'h1'))?.id).toBe(req.id);
        expect(await store.consumeApproval('r3', 'c1', 'h1')).toBeNull();
        expect(await store.findApprovedFor('r3', 'c1', 'h1')).toBeNull();
    });

    it('concurrent consumers cannot both win', async () => {
        const store = new HarnessStore('r4', ws);
        await store.saveRun(baseRun({ runId: 'r4' }));
        const req = await store.createApproval({ runId: 'r4', callId: 'c', role: 'dev', tool: 't', args: {}, argsHash: 'h', reason: 'r' });
        await store.decideApproval(req.id, true, 'user');
        const results = await Promise.all([1, 2, 3, 4].map(() => store.consumeApproval('r4', 'c', 'h')));
        expect(results.filter(Boolean)).toHaveLength(1);
    });
});
