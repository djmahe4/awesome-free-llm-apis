import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

// Systematic-debugging findings for the coding_agents test flake:
//  1. The first run in a process waited ~9 s on the llmfit hardware probe before the first model call (cached
//     afterwards), so tests that poll for ten seconds failed intermittently. A slow probe must not hold the edit.
//  2. On a slow machine `go vet` and `rustc` hit their 30 s timeout and the check was reported as clean
//     (no diagnostics at all). A check that did not finish must say so.

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawnSync: (...a: any[]) => spawnSyncMock(...a) }));

import { runGoVetCheck, runRustcCheck, runPythonAstCheck } from '../src/tools/coding-agents/diagnostics.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

const timedOut = () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync go ETIMEDOUT'), { code: 'ETIMEDOUT' }) });

let ws = '';
afterEach(async () => {
    vi.restoreAllMocks(); spawnSyncMock.mockReset(); delete process.env.CODING_AGENTS_LLMFIT_MS;
    if (ws) await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a checker that times out is reported, not treated as clean', () => {
    it('go vet', () => {
        spawnSyncMock.mockReturnValue(timedOut());
        const d = runGoVetCheck('main.go', process.cwd());
        expect(d).toHaveLength(1);
        expect(d[0].severity).toBe('warning');
        expect(d[0].message).toMatch(/go vet.*timed out/i);
    });

    it('rustc', () => {
        spawnSyncMock.mockReturnValue(timedOut());
        const d = runRustcCheck('src/main.rs', 'fn main() {}');
        expect(d.some(x => /rustc.*timed out/i.test(x.message))).toBe(true);
    });

    it('python', () => {
        spawnSyncMock.mockImplementation((cmd: string, args: string[]) => (args[0] === '--version' ? { status: 0, stdout: 'Python 3', stderr: '' } : timedOut()));
        const d = runPythonAstCheck('a.py', 'x = 1');
        expect(d.some(x => /python.*timed out/i.test(x.message))).toBe(true);
    });

    it('a missing compiler is still not an error (unchanged)', () => {
        spawnSyncMock.mockReturnValue({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync go ENOENT'), { code: 'ENOENT' }) });
        expect(runGoVetCheck('main.go', process.cwd())).toEqual([]);
    });
});

describe('a slow llmfit probe does not hold up the first edit', () => {
    it('the run finishes although the probe never answers', async () => {
        spawnSyncMock.mockImplementation((...a: any[]) => ({ status: 0, stdout: '[]', stderr: '' }));
        process.env.CODING_AGENTS_LLMFIT_MS = '300';
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-probe-'));
        await fs.ensureDir(path.join(ws, 'src'));
        await fs.writeFile(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
        const ollama = await import('../src/providers/ollama-local.js');
        vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
        const fit = await import('../src/services/llmfit.js');
        vi.spyOn(fit, 'recommendModels').mockImplementation(() => new Promise(() => {}));
        const lp = await import('../src/tools/local-llm-patch.js');
        vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({ success: true, patch: '<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE' } as any);
        const sessionId = `probe-${Date.now()}`;
        const started = Date.now();
        let r: any = await CodingAgentsHandler({ goal: 'set a to 2', workspaceRoot: ws, targetFiles: ['src/a.ts'], dryRun: false, topKFiles: 1, sessionId, review: false } as any);
        while (r.status === 'running' && Date.now() - started < 8000) {
            await new Promise(res => setTimeout(res, 50));
            r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
        }
        expect(r.status).not.toBe('running');
        expect(r.patchPlan[0].fullPatchedContent).toContain('a = 2');
    }, 20000);
});
