import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const llm = vi.fn();
vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...a: any[]) => llm(...a) }));

import { cyberTool } from '../src/tools/cyber-tool.js';
import { WikiMemory } from '../src/memory/wiki.js';

// C6: a coach/dag node was marked done with the text "(LLM call unavailable...)" when the model call
// failed, and wiki write failures were swallowed while the action still answered a plain success.

let repo = '';
beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cyber-persist-'));
    const tools = ['networking', 'recon', 'sqli', 'xss'].map(m => ({ name: `${m}-tool`, method: 'EXEC', url: `https://example.com/${m}`, module: m }));
    await fs.writeFile(path.join(repo, 'tools_config.json'), JSON.stringify(tools), 'utf-8');
});
afterAll(async () => { await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
afterEach(() => { vi.restoreAllMocks(); llm.mockReset(); });

async function startDag(sessionId: string) {
    llm.mockResolvedValue({ choices: [{ message: { content: 'notes' } }] });
    const r: any = await cyberTool({ action: 'learn', mode: 'dag_reverse', toolName: 'cybersec-toolkit', repoPath: repo, sessionId, sliceSize: 50 } as any);
    expect(r.success).toBe(true);
}
const coachNode = (sessionId: string) =>
    cyberTool({ action: 'coach', mode: 'dag_reverse', toolName: 'cybersec-toolkit', nodeId: 'cybersec-toolkit/networking', workspaceRoot: repo, sessionId } as any) as Promise<any>;

describe('C6: dag node honesty', () => {
    it('a failed model call leaves the node pending and says so, instead of marking it done', async () => {
        const sid = `c6-llm-${Date.now()}`;
        await startDag(sid);
        llm.mockReset();
        llm.mockRejectedValue(new Error('all providers failed'));
        const r = await coachNode(sid);
        expect(r.success).toBe(false);
        expect(r.status).toBe('pending');
        expect(r.error).toMatch(/all providers failed/);

        // and nothing was recorded as complete: the same node can be retried once the model is back
        llm.mockReset();
        llm.mockResolvedValue({ choices: [{ message: { content: 'real notes' } }] });
        const again = await coachNode(sid);
        expect(again.success).toBe(true);
        expect(again.status).toBe('done');
        expect(again.completedNodes).toBe(1);
    }, 40000);

    it('a wiki write failure is reported as persisted:false with the page, and the node is not marked done', async () => {
        const sid = `c6-wiki-${Date.now()}`;
        await startDag(sid);
        const realWrite = WikiMemory.prototype.write;
        vi.spyOn(WikiMemory.prototype, 'write').mockImplementation(async function (this: WikiMemory, title: string, ...rest: any[]) {
            if (title === 'cybersec-toolkit/networking') throw new Error('disk full');
            return (realWrite as any).call(this, title, ...rest);
        });
        const r = await coachNode(sid);
        expect(r.persisted).toBe(false);
        expect(r.persistWarnings).toEqual(expect.arrayContaining([expect.stringContaining('cybersec-toolkit/networking')]));
        expect(r.status).not.toBe('done');
        expect(r.success).toBe(false);
    }, 40000);

    it('when everything is written there is no warning field', async () => {
        const sid = `c6-ok-${Date.now()}`;
        await startDag(sid);
        const r = await coachNode(sid);
        expect(r.success).toBe(true);
        expect(r.persisted).not.toBe(false);
        expect(r.persistWarnings).toBeUndefined();
    }, 40000);
});

describe('C6: other actions report a failed save', () => {
    it('register_tool-style wiki writes: tool_memory save failure shows persisted:false', async () => {
        vi.spyOn(WikiMemory.prototype, 'write').mockRejectedValue(new Error('disk full'));
        const r: any = await cyberTool({ action: 'tool_memory', toolName: 'nmap', memoryOp: 'append', note: 'use -sV' } as any);
        expect(r.success).toBe(false);
    }, 20000);
});
