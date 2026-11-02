import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ResponseCache, REPLY_FORMAT_VERSION } from '../src/cache/index.js';
import type { ChatRequest, ChatResponse } from '../src/providers/types.js';

// #141: a reply is stored after the pipeline has decorated it, so a change in how replies are made must retire the old entries.

const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0 } as ChatRequest;
const reply = (text: string) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) as ChatResponse;

describe('response cache key', () => {
    it('carries the reply format version', () => {
        expect(typeof REPLY_FORMAT_VERSION).toBe('string');
        expect(REPLY_FORMAT_VERSION.length).toBeGreaterThan(0);
        expect(new ResponseCache().generateKey(request, 'ws')).toContain(REPLY_FORMAT_VERSION);
    });
    it('is stable for the same request', () => {
        const c = new ResponseCache();
        expect(c.generateKey(request, 'ws')).toBe(c.generateKey({ ...request }, 'ws'));
    });
    it('an entry saved without the version is never found', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-'));
        const file = path.join(dir, 'cache.json');
        try {
            const current = new ResponseCache(10, file);
            const key = current.generateKey(request, 'ws');
            const oldKey = key.replace(REPLY_FORMAT_VERSION, 'old-format');
            await fs.writeFile(file, JSON.stringify([[oldKey, reply('THOUGHTS: stale\n\nanswer')]]));
            const reloaded = new ResponseCache(10, file);
            await reloaded.init();
            expect(await reloaded.get(key)).toBeUndefined();
            await reloaded.set(key, reply('fresh'));
            expect((await reloaded.get(key))?.choices[0].message.content).toBe('fresh');
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
