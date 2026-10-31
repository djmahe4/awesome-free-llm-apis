import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WikiMemory } from '../src/memory/wiki.js';
import { checkPageClaims, claimMode } from '../src/memory/wiki-claims.js';
import { runHypothesisGate, writeHypothesesFile, HYPOTHESES_FILE } from '../src/tools/coding-agents/hypothesis-gate.js';

// Slice 5: claims on wiki pages are re-checked against the source at write time, and people editing hypotheses.md
// or a page by hand can neither break the mechanism nor talk it into believing something.

let ws = '';
let home = '';
const FILES = ['src/currency.ts'];
const table = (rows: string[]) => ['', '## Claims', '', '| id | claim | probe | status | evidence |', '|----|-------|-------|--------|----------|', ...rows, ''].join('\n');
const HEADER = '| id | claim | probe | status | evidence |\n|--|--|--|--|--|\n';
const DECISION = 'We decided to keep currency conversion in one module because rates change together.';

beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-ws-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-home-'));
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src/currency.ts'), 'export function convertCurrency(a: number, r: number) { return a * r; }\nexport function getUser(id: string) { return id; }\n');
});
afterAll(async () => {
    await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('checkPageClaims', () => {
    it('a page with no claims table has no verdict to give', async () => {
        expect((await checkPageClaims('just prose', ws)).verdict).toBe('no-claims');
    });
    it('confirmed claims make the page verified; one refuted claim makes it unverified', async () => {
        const ok = await checkPageClaims(table(['| c1 | x | `defined:getUser` | open | |']), ws);
        expect(ok.verdict).toBe('verified');
        const bad = await checkPageClaims(table(['| c1 | x | `defined:getUser` | open | |', '| c2 | y | `arity:getUser@src/currency.ts=3` | confirmed | trust me |']), ws);
        expect(bad.verdict).toBe('unverified');
    });
    it('a status typed by hand is overwritten with what the probe found', async () => {
        const r = await checkPageClaims(table(['| c1 | y | `arity:getUser@src/currency.ts=3` | confirmed | trust me |']), ws);
        expect(r.content).toMatch(/\| c1 \|.*\| refuted \|/);
        expect(r.content).not.toMatch(/trust me/);
    });
    it('a probe nobody can run is open, never confirmed, and does not make the page unverified', async () => {
        const r = await checkPageClaims(table(['| c1 | vibes | `vibes:ok` | confirmed | |']), ws);
        expect(r.claims[0].status).toBe('open');
        expect(r.verdict).toBe('no-claims');
    });
    it('leaves prose and CRLF pages intact', async () => {
        const r = await checkPageClaims(`intro\r\n${table(['| c1 | x | `defined:getUser` | open | |']).replace(/\n/g, '\r\n')}`, ws);
        expect(r.content).toContain('intro');
    });
});

describe('WikiMemory with claim checking', () => {
    const wikiAt = (name: string) => new WikiMemory(name, path.join(home, 'wiki'), ws);

    it('defaults to warn and honours the environment', () => {
        expect(claimMode()).toBe('warn');
        vi.stubEnv('WIKI_CLAIM_VERIFICATION', 'enforce'); expect(claimMode()).toBe('enforce');
        vi.stubEnv('WIKI_CLAIM_VERIFICATION', 'nonsense'); expect(claimMode()).toBe('warn');
        vi.unstubAllEnvs();
    });

    it('warn: a false claim tags the page unverified but changes nothing else', async () => {
        const w = wikiAt('warn');
        const bad = DECISION + table(['| c1 | y | `arity:getUser@src/currency.ts=3` | open | |']);
        let p: any; for (let i = 0; i < 5; i++) p = await w.write('Warn page', bad);
        expect(p.confidence).toBeGreaterThanOrEqual(0.85);
        expect((await w.read('Warn page'))!.tags).toContain('unverified');
    });

    it('enforce: confirmed claims climb to an ADR; false ones do not; the tag clears when the page is fixed', async () => {
        vi.stubEnv('WIKI_CLAIM_VERIFICATION', 'enforce');
        const w = wikiAt('enforce');
        const good = DECISION + table(['| c1 | y | `defined:convertCurrency` | open | |']);
        const bad = DECISION + table(['| c1 | y | `defined:noSuchThing` | open | |']);
        let p: any; for (let i = 0; i < 5; i++) p = await w.write('Bad page', bad);
        expect(p.adr_ref).toBeUndefined(); expect(p.confidence).toBeLessThan(0.5);
        expect((await w.read('Bad page'))!.tags).toContain('unverified');
        for (let i = 0; i < 6; i++) p = await w.write('Good page', good);
        expect(p.adr_ref).toBeTruthy();
        p = await w.write('Bad page', good);
        expect((await w.read('Bad page'))!.tags).not.toContain('unverified');
        for (let i = 0; i < 6; i++) p = await w.write('Plain', DECISION);
        expect(p.adr_ref).toBeUndefined(); expect(p.confidence).toBeLessThan(0.85);
        vi.unstubAllEnvs();
    });

    it('without a workspace root nothing changes', async () => {
        vi.stubEnv('WIKI_CLAIM_VERIFICATION', 'enforce');
        const w = new WikiMemory('plain-root', path.join(home, 'wiki'));
        let p: any; for (let i = 0; i < 6; i++) p = await w.write('No root', DECISION);
        expect(p.confidence).toBeGreaterThanOrEqual(0.85);
        vi.unstubAllEnvs();
    });
});

describe('hypotheses.md edited by a person', () => {
    const file = () => path.join(ws, HYPOTHESES_FILE);
    const gate = (mode: 'warn' | 'enforce' = 'warn') => runHypothesisGate({ mode, goal: 'tidy `getUser`', files: FILES, workspaceRoot: ws });

    it('keeps their u-row and their note, and re-checks the row', async () => {
        let g = await gate(); await writeHypothesesFile(ws, 'tidy `getUser`', g.hypotheses);
        await fs.appendFile(file(), '\n| u1 | convertCurrency takes two arguments | `arity:convertCurrency@src/currency.ts=2` | open | |\n\nNote: check rounding.\n');
        g = await gate(); await writeHypothesesFile(ws, 'tidy `getUser`', g.hypotheses);
        const md = await fs.readFile(file(), 'utf-8');
        expect(g.hypotheses.find(h => h.id === 'u1')?.status).toBe('confirmed');
        expect(md.match(/Note: check rounding\./g)).toHaveLength(1);
    });
    it('does not believe a status they typed', async () => {
        await fs.writeFile(file(), HEADER + '| u2 | wrong | `arity:getUser@src/currency.ts=3` | confirmed | by hand |\n');
        expect((await gate()).hypotheses.find(h => h.id === 'u2')?.status).toBe('refuted');
    });
    it('a row with an unrunnable probe stays open and never blocks', async () => {
        await fs.writeFile(file(), HEADER + '| u3 | hope | `vibes:ok` | confirmed | |\n');
        const g = await gate('enforce');
        expect(g.hypotheses.find(h => h.id === 'u3')?.status).toBe('open'); expect(g.blocked).toBe(false);
    });
    it('a false row of theirs blocks under enforce like any other assumption', async () => {
        await fs.writeFile(file(), HEADER + '| u4 | exists | `defined:normalizeCurrency` | open | |\n');
        const g = await gate('enforce'); expect(g.blocked).toBe(true); expect(g.summary).toMatch(/normalizeCurrency/);
    });
    it('rows left by an earlier run are not carried forward', async () => {
        await fs.writeFile(file(), HEADER + '| h1 | old | `file:src/gone.ts` | refuted | missing |\n');
        expect((await gate('enforce')).blocked).toBe(false);
    });
    it('a mangled file does not throw', async () => {
        await fs.writeFile(file(), '# x\r\n| id | claim |\r\n| h1 |\r\nstray | text\r\n');
        await expect(gate()).resolves.toBeTruthy();
    });
});
