import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { parseProbe, runProbe, validateHypotheses, serializeHypothesesMarkdown, parseHypothesesMarkdown, countParams, type Hypothesis } from '../src/tools/coding-agents/hypotheses.js';

// Slice 2 of the grounded coding_agents plan: a plan states what it assumes as hypotheses, and each one is
// checked by a mechanical probe against the real files. The model proposes claim + probe; it never writes the verdict.

let ws = '';
const W = (rel: string, body: string) => fs.writeFile(path.join(ws, rel), body);
beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-'));
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await W('src/a.ts', [
        'export function plain(a: number, b: string) {}',
        'export async function withDefaults(a: number, b = { x: 1, y: [1, 2] }, ...rest: number[]) {}',
        'export const arrow = (x: Map<string, number>, y: Array<[number, number]>) => x;',
        'export class Box { method(one: string, two?: number) {} }',
        'export interface Shape { area(): number }',
        'export type Id = string;',
        'export enum Mode { A, B }',
        'const DEFAULT = 5;',
    ].join('\n') + '\n');
    await W('src/b.py', ['def f(a, b=2, *args, **kw):', '    pass', 'class C:', '    def m(self, x): pass', '    @classmethod', '    def k(cls, y): pass'].join('\n') + '\n');
    await W('src/c.go', ['package c', 'func Add(a, b int) int { return a + b }', 'func (s *S) Method(x string) {}'].join('\n') + '\n');
    await W('src/d.rs', ['pub fn run(a: i32, b: &str) -> i32 { a }', 'pub struct Thing;', 'enum Kind { A }'].join('\n') + '\n');
});
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('parseProbe', () => {
    it.each([
        ['file:src/a.ts', { kind: 'file', path: 'src/a.ts' }],
        ['symbol:plain@src/a.ts', { kind: 'symbol', name: 'plain', path: 'src/a.ts' }],
        ['arity:plain@src/a.ts=2', { kind: 'arity', name: 'plain', path: 'src/a.ts', expected: 2 }],
        ['grep:DEFAULT = \\d@src/a.ts', { kind: 'grep', pattern: 'DEFAULT = \\d', path: 'src/a.ts' }],
        ['cite:src/a.ts:L1-L2#abcd1234', { kind: 'cite', path: 'src/a.ts', from: 1, to: 2, hash: 'abcd1234' }],
    ])('%s', (text, expected) => { expect(parseProbe(text)).toMatchObject(expected as any); });

    it.each(['', 'nonsense', 'file:', 'symbol:x', 'arity:f@a.ts=abc', 'cite:a.ts:L9', 'cmd:rm -rf /'])('rejects %j', (text) => {
        expect(parseProbe(text)).toBeNull();
    });
});

describe('countParams', () => {
    it.each([
        ['(a: number, b: string)', 2],
        ['(a: number, b = { x: 1, y: [1, 2] }, ...rest: number[])', 3],
        ['(x: Map<string, number>, y: Array<[number, number]>)', 2],
        ['()', 0],
        ['(one: string, two?: number)', 2],
        ['({ a, b }: Props, c: number)', 2],
        ['(self, x)', 1],
        ['(cls, y)', 1],
        ['(a, b=2, *args, **kw)', 4],
    ])('%s -> %i', (params, n) => { expect(countParams(params)).toBe(n); });
});

describe('runProbe: file', () => {
    it('confirms an existing file and refutes a missing or escaping one', async () => {
        expect((await runProbe('file:src/a.ts', ws)).status).toBe('confirmed');
        const missing = await runProbe('file:src/nope.ts', ws);
        expect(missing.status).toBe('refuted'); expect(missing.evidence).toMatch(/not found|does not exist/i);
        expect((await runProbe('file:../../etc/passwd', ws)).status).toBe('refuted');
        expect((await runProbe('file:src', ws)).status).toBe('refuted'); // a directory is not a file
    });
});

describe('runProbe: symbol', () => {
    it.each([
        ['plain', 'src/a.ts'], ['withDefaults', 'src/a.ts'], ['arrow', 'src/a.ts'], ['Box', 'src/a.ts'], ['Shape', 'src/a.ts'],
        ['Id', 'src/a.ts'], ['Mode', 'src/a.ts'], ['DEFAULT', 'src/a.ts'], ['method', 'src/a.ts'],
        ['f', 'src/b.py'], ['C', 'src/b.py'], ['m', 'src/b.py'], ['Add', 'src/c.go'], ['Method', 'src/c.go'], ['run', 'src/d.rs'], ['Thing', 'src/d.rs'], ['Kind', 'src/d.rs'],
    ])('finds %s in %s', async (name, file) => {
        const r = await runProbe(`symbol:${name}@${file}`, ws);
        expect(r.status).toBe('confirmed');
        expect(r.evidence).toMatch(/L\d+/);   // names the line
    });

    it('refutes a name that is only mentioned, not defined', async () => {
        await W('src/e.ts', '// plain mentions fetchUser in a comment\nconst s = "fetchUser";\nexport const other = 1;\n');
        const r = await runProbe('symbol:fetchUser@src/e.ts', ws);
        expect(r.status).toBe('refuted');
    });

    it('refutes a missing file with a reason, and does not throw', async () => {
        const r = await runProbe('symbol:x@src/none.ts', ws);
        expect(r.status).toBe('refuted'); expect(r.evidence).toMatch(/not found|does not exist/i);
    });
});

describe('runProbe: arity', () => {
    it.each([
        ['plain', 'src/a.ts', 2, 'confirmed'], ['plain', 'src/a.ts', 3, 'refuted'],
        ['withDefaults', 'src/a.ts', 3, 'confirmed'], ['arrow', 'src/a.ts', 2, 'confirmed'], ['method', 'src/a.ts', 2, 'confirmed'],
        ['f', 'src/b.py', 4, 'confirmed'], ['m', 'src/b.py', 1, 'confirmed'], ['k', 'src/b.py', 1, 'confirmed'],
        ['Add', 'src/c.go', 2, 'confirmed'], ['run', 'src/d.rs', 2, 'confirmed'],
    ])('%s in %s has %i params -> %s', async (name, file, n, status) => {
        const r = await runProbe(`arity:${name}@${file}=${n}`, ws);
        expect(r.status).toBe(status);
        expect(r.evidence).toMatch(/\d/);
    });
    it('refuting says how many it actually has', async () => {
        expect((await runProbe('arity:plain@src/a.ts=5', ws)).evidence).toMatch(/2/);
    });
    it.each([['Box', 'src/a.ts'], ['Shape', 'src/a.ts'], ['Mode', 'src/a.ts'], ['Id', 'src/a.ts'], ['C', 'src/b.py'], ['Thing', 'src/d.rs']])(
        'a %s in %s is not callable: no parameter list to count, even if a method inside it has one', async (name, file) => {
        const r = await runProbe(`arity:${name}@${file}=2`, ws);
        expect(r.status).toBe('refuted');
        expect(r.evidence).toMatch(/not a function|no parameter list/i);
    });
    it('a constant that is not a function has none either', async () => {
        expect((await runProbe('arity:DEFAULT@src/a.ts=0', ws)).status).toBe('refuted');
    });
    it('a function that is not there is refuted', async () => {
        expect((await runProbe('arity:ghost@src/a.ts=1', ws)).status).toBe('refuted');
    });
});

describe('runProbe: grep and cite', () => {
    it('grep confirms a match and quotes the line; refutes no match; bad regex is refuted not thrown', async () => {
        const hit = await runProbe('grep:DEFAULT = 5@src/a.ts', ws);
        expect(hit.status).toBe('confirmed'); expect(hit.evidence).toMatch(/L8/);
        expect((await runProbe('grep:DEFAULT = 6@src/a.ts', ws)).status).toBe('refuted');
        const bad = await runProbe('grep:([@src/a.ts', ws);
        expect(bad.status).toBe('refuted'); expect(bad.evidence).toMatch(/invalid/i);
    });

    it('cite confirms when the cited lines still hash to the recorded prefix', async () => {
        const lines = (await fs.readFile(path.join(ws, 'src/a.ts'), 'utf-8')).split('\n');
        const hash = crypto.createHash('sha256').update(lines.slice(0, 2).join('\n')).digest('hex').slice(0, 8);
        expect((await runProbe(`cite:src/a.ts:L1-L2#${hash}`, ws)).status).toBe('confirmed');
        expect((await runProbe('cite:src/a.ts:L1-L2#deadbeef', ws)).status).toBe('refuted');
        expect((await runProbe('cite:src/a.ts:L500-L600#deadbeef', ws)).status).toBe('refuted');
    });
});

describe('validateHypotheses', () => {
    const h = (id: string, probe: string, extra: Partial<Hypothesis> = {}): Hypothesis => ({ id, claim: `claim ${id}`, probe, status: 'open', ...extra });

    it('fills status and evidence for each, in order', async () => {
        const out = await validateHypotheses([h('h1', 'file:src/a.ts'), h('h2', 'symbol:ghost@src/a.ts')], ws);
        expect(out.map(o => [o.id, o.status])).toEqual([['h1', 'confirmed'], ['h2', 'refuted']]);
        expect(out.every(o => o.evidence)).toBe(true);
    });

    it('a probe that cannot be parsed is refuted with that reason, never left open', async () => {
        const out = await validateHypotheses([h('h1', 'run the tests and see')], ws);
        expect(out[0].status).toBe('refuted'); expect(out[0].evidence).toMatch(/probe/i);
    });

    it('ignores a status the model wrote: the probe decides', async () => {
        const out = await validateHypotheses([h('h1', 'symbol:ghost@src/a.ts', { status: 'confirmed', evidence: 'trust me' })], ws);
        expect(out[0].status).toBe('refuted'); expect(out[0].evidence).not.toContain('trust me');
    });
});

describe('hypotheses.md', () => {
    const list: Hypothesis[] = [
        { id: 'h1', claim: 'currency.ts exists', probe: 'file:src/currency.ts', status: 'confirmed', evidence: 'found' },
        { id: 'h2', claim: 'has a | pipe and `ticks`', probe: 'grep:a\\|b@src/x.ts', status: 'refuted', evidence: 'no match' },
        { id: 'h3', claim: 'still open', probe: 'file:src/z.ts', status: 'open' },
    ];
    it('round-trips, including claims with pipes and backticks', () => {
        const md = serializeHypothesesMarkdown('make the converter robust', list);
        expect(md).toMatch(/^# Hypotheses: make the converter robust/);
        expect(parseHypothesesMarkdown(md)).toEqual(list);
    });
    it('an empty or garbage file parses to no hypotheses', () => {
        expect(parseHypothesesMarkdown('')).toEqual([]);
        expect(parseHypothesesMarkdown('hello\nworld')).toEqual([]);
    });
});
