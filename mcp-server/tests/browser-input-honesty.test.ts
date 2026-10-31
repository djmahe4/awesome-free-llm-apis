import { describe, it, expect, afterEach } from 'vitest';
import { parseInput } from '../src/browser/actionSchemas.js';
import { dispatchBrowserAction } from '../src/browser/dispatch.js';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool, setBrowserSessionPoolForTesting } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';
import { replayConfidence } from '../src/browser/limits.js';

// B13-15: a misspelled option vanished silently, validation errors were a raw zod JSON dump, deep_scrape
// "succeeded" with nothing, and api_replay always claimed confidence 1.

afterEach(() => setBrowserSessionPoolForTesting(null));

describe('parseInput', () => {
    it('rejects an option the action does not have, naming it and the allowed ones', () => {
        expect(() => parseInput({ action: 'click', params: { by: 'text', value: 'Go', idx: 2 } })).toThrow(/Unknown option.*idx/);
        try { parseInput({ action: 'click', params: { by: 'text', value: 'Go', idx: 2 } }); } catch (e: any) {
            expect(e.message).toMatch(/allowed.*scrollIntoView/i);
        }
    });

    it('turns validation failures into one readable line, not a JSON dump', () => {
        try { parseInput({ action: 'click', params: { by: 'bogus', value: 'x' } }); throw new Error('should have thrown'); } catch (e: any) {
            expect(e.message).toMatch(/params\.by/);
            expect(e.message).not.toMatch(/^\s*\[/);
            expect(e.message).not.toContain('"code"');
        }
        try { parseInput({ action: 'nope' }); throw new Error('should have thrown'); } catch (e: any) {
            expect(e.message).toMatch(/action/);
            expect(e.message).not.toContain('"code"');
        }
    });

    it('known options, top-level url on navigate, and the passthrough scrape macro are unaffected', () => {
        expect(parseInput({ action: 'click', params: { by: 'text', value: 'Go', scrollIntoView: false } }).params).toMatchObject({ by: 'text' });
        expect(parseInput({ action: 'navigate', url: 'https://example.com' }).params).toMatchObject({ url: 'https://example.com' });
        expect(() => parseInput({ action: 'scrape', url: 'https://example.com', params: { anything: 1 } })).not.toThrow();
    });
});

describe('deep_scrape', () => {
    it('with nothing to follow it fails and says why, instead of succeeding with 0 records', async () => {
        const pool = new BrowserSessionPool(async (id: string) => new BrowserSession(id, new FakeDevToolsClient()));
        setBrowserSessionPoolForTesting(pool);
        const r: any = await dispatchBrowserAction({ action: 'deep_scrape', sessionId: 's-deep', params: {} });
        expect(r.success).toBe(false);
        expect(r.errors[0].code).toBe('NO_DEEP_RECORDS');
        expect(r.errors[0].message).toMatch(/extract/i);
        await pool.shutdownAll();
    });
});

describe('replayConfidence', () => {
    it('is the share of replayed endpoints that worked, and 0 when nothing came back', () => {
        expect(replayConfidence(4, 0, 12)).toBe(1);
        expect(replayConfidence(4, 1, 12)).toBe(0.75);
        expect(replayConfidence(4, 3, 2)).toBe(0.25);
        expect(replayConfidence(4, 4, 0)).toBe(0);
        expect(replayConfidence(0, 0, 0)).toBe(0);
    });
});
