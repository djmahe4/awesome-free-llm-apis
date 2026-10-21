import { describe, it, expect } from 'vitest';
import { jaccardSimilarity, collapseSimilarLines } from '../src/utils/log-compaction.js';

describe('jaccardSimilarity', () => {
  it('treats lines that differ only in numbers and ids as identical', () => {
    expect(jaccardSimilarity('request 4312 took 18ms', 'request 4313 took 21ms')).toBe(1);
    expect(jaccardSimilarity('GET /a id=abc123', 'GET /a id=zzz999')).toBe(1);
  });
  it('separates genuinely different lines', () => {
    expect(jaccardSimilarity('connection refused by upstream', 'user logged in successfully')).toBeLessThan(0.2);
  });
  it('never merges markdown headers or preserved lines', () => {
    expect(jaccardSimilarity('# Title one', '# Title two')).toBe(0);
    expect(jaccardSimilarity('"jsCode": "x"', '"jsCode": "y"', s => s.includes('jsCode'))).toBe(0);
  });
  it('two empty token sets are equal', () => {
    expect(jaccardSimilarity('---', '===')).toBe(1);
  });
});

describe('collapseSimilarLines', () => {
  it('keeps head and tail, collapses a run of near-duplicates, and reports the count', () => {
    const lines = ['START', 'init ok', ...Array.from({ length: 50 }, (_, i) => `poll ${i} returned 200 in ${i + 3}ms`), 'ERROR: disk full', 'shutdown', 'END'];
    const out = collapseSimilarLines(lines, { head: 2, tail: 3 });
    expect(out.slice(0, 2)).toEqual(['START', 'init ok']);
    expect(out.slice(-3)).toEqual(['ERROR: disk full', 'shutdown', 'END']);
    expect(out.some(l => /50 similar lines collapsed/.test(l))).toBe(true);
    expect(out.length).toBeLessThan(10);
  });
  it('leaves a short input untouched (only clipping long lines)', () => {
    expect(collapseSimilarLines(['a', 'b', 'c'], { head: 3, tail: 3 })).toEqual(['a', 'b', 'c']);
    expect(collapseSimilarLines(['x'.repeat(500)], { maxLineChars: 10 })[0]).toBe('xxxxxxxxxx... (truncated)');
  });
  it('does not collapse distinct lines', () => {
    const lines = ['h', ...['alpha failed', 'beta timed out', 'gamma crashed', 'delta leaked'], 't'];
    expect(collapseSimilarLines(lines, { head: 1, tail: 1 })).toEqual(lines);
  });
});
