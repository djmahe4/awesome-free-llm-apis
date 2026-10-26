import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { WikiMemory } from '../src/memory/wiki.js';

// M1: an empty or punctuation-only title became "___.md", so unrelated pages overwrote each other.

let dir = '';
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-names-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('wiki filenames', () => {
    it('different punctuation-only titles are different pages', async () => {
        const w = new WikiMemory('h1', dir);
        await w.write('???', 'first');
        await w.write('!!!', 'second');
        expect((await w.read('???'))?.content).toContain('first');
        expect((await w.read('!!!'))?.content).toContain('second');
    });

    it('an empty title is refused', async () => {
        const w = new WikiMemory('h2', dir);
        await expect(w.write('', 'x')).rejects.toThrow(/title/i);
        await expect(w.write('   ', 'x')).rejects.toThrow(/title/i);
    });

    it('ordinary titles keep their readable names', async () => {
        const w = new WikiMemory('h3', dir);
        await w.write('Auth Design', 'x');
        const files = await fs.readdir(path.join(dir, 'h3'));
        expect(files).toContain('auth_design.md');
    });
});

describe('namespace cannot leave the wiki folder', () => {
    it.each(['../escape', '..\escape', 'a/b', '..', 'a\0b'])('WikiMemory refuses %j', (ns) => {
        expect(() => new WikiMemory(ns, dir)).toThrow(/namespace|workspace hash/i);
    });

    it('manage_memory refuses a bad namespace on every wiki/adr action and writes nothing outside', async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-ns-'));
        process.env.FREE_LLM_MCP_HOME = home;
        const { manageMemory } = await import('../src/tools/manage-memory.js');
        for (const action of ['wiki_write', 'adr_write', 'wiki_read', 'wiki_list', 'wiki_search', 'adr_list']) {
            await expect(manageMemory({ action, workspace_root: home, namespace: '../../outside', title: 't', content: 'c', query: 'q' } as any)).rejects.toThrow(/namespace/i);
        }
        await expect(manageMemory({ action: 'wiki_write', workspace_root: home, namespace: 'x'.repeat(65), title: 't', content: 'c' } as any)).rejects.toThrow(/namespace/i);
        await expect(manageMemory({ action: 'wiki_list', workspace_root: home, namespace: 'team-a.v1_2' } as any)).resolves.toBeTruthy();
        await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        delete process.env.FREE_LLM_MCP_HOME;
    });
});
