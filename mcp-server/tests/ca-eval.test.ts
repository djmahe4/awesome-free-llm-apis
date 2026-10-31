import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compare, countChecks, runFixtures, FIXTURES, type Report } from '../scripts/smoke/ca_eval.js';

// Slice 7: the evaluation runner fails when a planted hallucination gets through, and when a check is quietly removed.

const report = (...f: Array<[string, boolean, number]>): Report => ({ generatedAt: '', fixtures: f.map(([name, passed, checks]) => ({ name, covers: '', passed, checks, ms: 1 })) });

describe('countChecks', () => {
    it('counts ok and PASS lines but not the PASS: summary', () => {
        expect(countChecks('ok   a\nPASS  b\nPASS: all good\nFAIL  c\nnoise')).toBe(2);
    });
    it('counts the dashboard smoke claims line', () => { expect(countChecks('58/58 claims confirmed against the handler source')).toBe(58); });
    it('copes with CRLF', () => { expect(countChecks('ok   a\r\nok   b\r\n')).toBe(2); });
});

describe('compare', () => {
    it('is clean when everything passes and nothing shrank', () => {
        expect(compare(report(['a', true, 5]), report(['a', true, 5]))).toEqual([]);
        expect(compare(report(['a', true, 5]), report(['a', true, 7]))).toEqual([]);
    });
    it('names a failing fixture, with or without a baseline', () => {
        expect(compare(null, report(['a', false, 0]))).toEqual(['a: failed']);
    });
    it('catches a fixture that disappeared', () => {
        expect(compare(report(['a', true, 5], ['b', true, 2]), report(['a', true, 5])).join()).toMatch(/b: in the baseline but not run/);
    });
    it('catches a check that was removed to make a fixture green', () => {
        expect(compare(report(['a', true, 5]), report(['a', true, 4])).join()).toMatch(/a: 4 passing checks, baseline has 5/);
    });
});

describe('runFixtures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-eval-'));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    it('records a passing and a failing script by exit code, with its checks', async () => {
        fs.writeFileSync(path.join(dir, 'good.mjs'), "console.log('ok   one');console.log('ok   two');");
        fs.writeFileSync(path.join(dir, 'bad.mjs'), "console.log('ok   one');process.exit(1);");
        const r = await runFixtures([{ name: 'good', covers: 'x', script: 'good.mjs' }, { name: 'bad', covers: 'x', script: 'bad.mjs' }, { name: 'missing', covers: 'x', script: 'nope.mjs' }], dir);
        expect(r.fixtures.map(f => [f.name, f.passed, f.checks])).toEqual([['good', true, 2], ['bad', false, 1], ['missing', false, 0]]);
    });
});

describe('the committed baseline', () => {
    it('covers every fixture the runner knows, so none can be dropped silently', () => {
        const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/smoke/results/baseline.json'), 'utf-8')) as Report;
        expect(baseline.fixtures.map(f => f.name).sort()).toEqual(FIXTURES.map(f => f.name).sort());
        expect(baseline.fixtures.every(f => f.passed && f.checks > 0)).toBe(true);
    });
});
