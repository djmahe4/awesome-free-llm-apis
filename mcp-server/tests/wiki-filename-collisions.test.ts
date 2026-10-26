import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { WikiMemory } from '../src/memory/wiki.js';

// M1: an empty or punctuation-only title became "___.md", so unrelated pages overwrote each other.

let dir = '';
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-names-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

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
