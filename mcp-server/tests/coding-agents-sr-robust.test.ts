import { describe, it, expect } from 'vitest';
import {
  parseSearchReplaceBlocks,
  parseSearchReplaceBlocksDetailed,
  applySearchReplaceBlocks,
  isAdditiveInstruction,
  isNoopPatch,
} from '../src/tools/coding-agents/patch-gen.js';

const block = (s: string, r: string) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

describe('parseSearchReplaceBlocksDetailed', () => {
  it('keeps complete blocks in order, tolerates prose between them, and counts a block cut off before REPLACE', () => {
    const text = [
      'Here are the edits:',
      block('const a = 1;', 'const a = 2;'),
      'and another one:',
      block('const b = 1;', 'const b = 2;'),
      '<<<<<<< SEARCH',
      'const c = 1;',
      '=======',
      'const c = 3;',
    ].join('\n');
    const r = parseSearchReplaceBlocksDetailed(text);
    expect(r.blocks.map(b => b.search)).toEqual(['const a = 1;', 'const b = 1;']);
    expect(r.incomplete).toBe(1);
  });

  it('parses an empty SEARCH without swallowing the next block, and CRLF input', () => {
    const text = [block('', 'export const x = 1;'), block('foo', 'bar')].join('\r\n');
    const { blocks, incomplete } = parseSearchReplaceBlocksDetailed(text);
    expect(blocks).toEqual([{ search: '', replace: 'export const x = 1;' }, { search: 'foo', replace: 'bar' }]);
    expect(incomplete).toBe(0);
    expect(parseSearchReplaceBlocks(text)).toHaveLength(2);
  });
});

describe('applySearchReplaceBlocks: empty SEARCH', () => {
  const file = 'line1\nline2\n';
  it('is rejected by default with a message that tells the model what to do', () => {
    const r = applySearchReplaceBlocks(file, [{ search: '', replace: 'NEW' }]);
    expect(r.appliedCount).toBe(0);
    expect(r.content).toBe(file);
    expect(r.failures[0]).toMatch(/anchor/i);
  });
  it('appends at the end of the file when allowAppend is set', () => {
    const r = applySearchReplaceBlocks(file, [{ search: '', replace: 'NEW' }], { allowAppend: true });
    expect(r.appliedCount).toBe(1);
    expect(r.content.trimEnd().endsWith('NEW')).toBe(true);
    expect(r.content.startsWith('line1\nline2')).toBe(true);
  });
  it('creates content in an empty file', () => {
    const r = applySearchReplaceBlocks('', [{ search: '', replace: 'NEW' }]);
    expect(r.appliedCount).toBe(1);
    expect(r.content).toContain('NEW');
  });
});

describe('applySearchReplaceBlocks: additive anchor retention', () => {
  const file = 'class A {\n  run() {}\n}\n';
  it('rejects a block that deletes its anchor when the instruction only adds code', () => {
    const r = applySearchReplaceBlocks(file, [{ search: '  run() {}', replace: '  runNew() {}' }], { additive: true });
    expect(r.appliedCount).toBe(0);
    expect(r.content).toBe(file);
    expect(r.failures[0]).toMatch(/anchor not retained/i);
  });
  it('accepts a block that keeps the anchor and adds lines', () => {
    const r = applySearchReplaceBlocks(file, [{ search: '  run() {}', replace: '  run() {}\n  extra() {}' }], { additive: true });
    expect(r.appliedCount).toBe(1);
    expect(r.content).toContain('run() {}');
    expect(r.content).toContain('extra() {}');
  });
  it('is tolerant of indentation drift in the retained anchor', () => {
    const r = applySearchReplaceBlocks(file, [{ search: '  run() {}', replace: 'run() {}\n  extra() {}' }], { additive: true });
    expect(r.appliedCount).toBe(1);
  });
  it('does not apply the guard to non-additive edits (a rename is allowed to drop the anchor)', () => {
    const r = applySearchReplaceBlocks(file, [{ search: '  run() {}', replace: '  runNew() {}' }]);
    expect(r.appliedCount).toBe(1);
  });
});

describe('isAdditiveInstruction', () => {
  it('detects add-style instructions and not edits that change or remove code', () => {
    expect(isAdditiveInstruction('add a method reset() to class Counter')).toBe(true);
    expect(isAdditiveInstruction('Implement a retry helper and export it')).toBe(true);
    expect(isAdditiveInstruction('rename foo to bar')).toBe(false);
    expect(isAdditiveInstruction('remove the unused import')).toBe(false);
    expect(isAdditiveInstruction('add logging but replace the old logger')).toBe(false);
  });
});

describe('isNoopPatch', () => {
  it('is true when the proposal equals the original, ignoring CR and trailing blank lines', () => {
    expect(isNoopPatch(['a', 'b', ''], ['a', 'b'])).toBe(true);
    expect(isNoopPatch(['a\r', 'b\r'], ['a', 'b'])).toBe(true);
    expect(isNoopPatch([], [])).toBe(true);
  });
  it('is false for any real difference, including whitespace inside a line', () => {
    expect(isNoopPatch(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(isNoopPatch(['a', 'b'], ['a', ' b'])).toBe(false);
    expect(isNoopPatch(['a'], ['A'])).toBe(false);
  });
});
