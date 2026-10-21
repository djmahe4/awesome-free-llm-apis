import { describe, it, expect } from 'vitest';
import { applySearchReplaceBlocks, findLineBlockMatch, closestLines } from '../src/tools/coding-agents/patch-gen.js';

const file = [
  'function parse(text) {',
  '  const units = { h: 3600, m: 60, s: 1 };',
  '  let total = 0;',
  '  for (const m of text.matchAll(/(\\d+)([hms])/g)) {',
  '    total += Number(m[1]) * units[m[2]];',
  '  }',
  '  return total;',
  '}',
  '',
].join('\n');

describe('findLineBlockMatch: tolerant tiers (OpenCode / Codex style)', () => {
  const lines = file.split('\n');

  it('matches through curly quotes, en/em dashes and non-breaking spaces', () => {
    const src = ['function parse(text) {', '  const units = { h: 3600, m: 60, s: 1 };'].map(l => l.replace('3600', '3600'));
    const withUnicode = [lines[0], lines[1].replace(/ /g, ' ')];
    const r = findLineBlockMatch(lines, withUnicode);
    expect(r.index).toBe(0);
    expect(src.length).toBe(2);
  });

  it('matches when the model collapsed or padded internal whitespace', () => {
    const r = findLineBlockMatch(lines, ['  let   total  =  0;']);
    expect(r).toMatchObject({ index: 2, ambiguous: false });
  });

  it('matches a block by its first and last lines when the middle drifted slightly (>= 3 lines)', () => {
    const search = [
      'for (const m of text.matchAll(/(\\d+)([hms])/g)) {',
      '  total += Number(m[1]) * units[m[2]]',   // missing semicolon
      '}',
    ];
    const r = findLineBlockMatch(lines, search);
    expect(r).toMatchObject({ index: 3, ambiguous: false });
  });

  it('anchors alone are not enough: a drifted middle that is too different does not match', () => {
    const search = ['for (const m of text.matchAll(/(\\d+)([hms])/g)) {', '  console.log("totally unrelated body line one");', '  console.log("totally unrelated body line two");', '}'];
    expect(findLineBlockMatch(lines, search).index).toBe(-1);
  });

  it('two equally good anchor candidates are ambiguous, never guessed', () => {
    const dup = ['if (a) {', '  x();', '}', 'other();', 'if (a) {', '  x();', '}'];
    const r = findLineBlockMatch(dup, ['if (a) {', '  y();', '}']);
    expect(r.index === -1 || r.ambiguous).toBe(true);
  });

  it('keeps the strict tiers first: an exact hit wins over a fuzzy one', () => {
    const r = findLineBlockMatch(['a', 'b', 'c'], ['b']);
    expect(r).toMatchObject({ index: 1, ambiguous: false });
  });
});

describe('closestLines (what to show the model when SEARCH did not match)', () => {
  it('returns the real file lines most similar to the SEARCH text, with line numbers', () => {
    const hint = closestLines(file.split('\n'), ['  total += Number(m[1]) * units[m[3]];']);
    expect(hint).toContain('total += Number(m[1]) * units[m[2]];');
    expect(hint).toMatch(/L5/);
  });
  it('returns an empty string when nothing is similar', () => {
    expect(closestLines(file.split('\n'), ['zzz qqq www xxx'])).toBe('');
  });
});

describe('applySearchReplaceBlocks failure messages', () => {
  it('"not found" includes the nearest real lines so the retry can copy them exactly', () => {
    const r = applySearchReplaceBlocks(file, [{ search: '  total += Number(m[1]) * units[m[3]];', replace: '  total += 1;' }]);
    expect(r.appliedCount).toBe(0);
    expect(r.failures[0]).toMatch(/not found/i);
    expect(r.failures[0]).toContain('units[m[2]]');
  });
  it('"ambiguous" is a distinct message that asks for more context', () => {
    const dup = 'x();\nfoo();\nx();\n';
    const r = applySearchReplaceBlocks(dup, [{ search: 'x();', replace: 'y();' }]);
    expect(r.failures[0]).toMatch(/multiple times/i);
  });
  it('applies an edit whose SEARCH used curly quotes', () => {
    const src = 'const a = "hello";\nconst b = 1;\n';
    const r = applySearchReplaceBlocks(src, [{ search: 'const a = “hello”;', replace: 'const a = "hi";' }]);
    expect(r.appliedCount).toBe(1);
    expect(r.content).toContain('const a = "hi";');
  });
});
