import { describe, expect, it } from 'vitest';
import { buildRepairBrief } from '../src/tools/coding-agents/verify-guard.js';

const OUTPUT = [
  '✖ parseThread (2.0798ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
  '  + actual - expected',
  '',
  '    [',
  '      {',
  "  +     role: 'User',",
  "  -     role: 'user',",
  "        text: 'hi'",
  '      }',
  '    ]',
  '',
  '      at TestContext.<anonymous> (tests/threads.test.js:7:10)',
  '    generatedMessage: true,',
  '    actual: [Array],',
  '    expected: [Array],',
  "    operator: 'deepStrictEqual',",
].join('\n');

describe('repair brief keeps the node:test diff', () => {
  const brief = buildRepairBrief({ command: 'node tests/threads.test.js', exitCode: 1, outputTail: OUTPUT, patchedFiles: ['src/threads.js'] });
  it('shows the value that is wrong', () => {
    expect(brief).toContain("+     role: 'User',");
    expect(brief).toContain("-     role: 'user',");
    expect(brief).toContain('What differs');
  });
  it('drops the opaque actual/expected lines that carry no value', () => {
    expect(brief).not.toContain('actual: [Array]');
    expect(brief).not.toContain('expected: [Array]');
  });
  it('is unchanged for output without a diff block', () => {
    const plain = buildRepairBrief({ command: 'x', exitCode: 1, outputTail: 'AssertionError: expected 3 to equal 4', patchedFiles: [] });
    expect(plain).not.toContain('What differs');
    expect(plain).toContain('expected 3 to equal 4');
  });
});

import { diffValueHints } from '../src/tools/coding-agents/verify-guard.js';

describe('diffValueHints', () => {
  it('names a different value (Agent -> assistant) as a mapping, not a casing fix', () => {
    const hints = diffValueHints(["  +     role: 'Agent',\n  -     role: 'assistant',\n        text: 'hello'"]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("your code gives 'Agent', the test expects 'assistant'");
    expect(hints[0]).toContain('explicit mapping');
  });
  it('calls a case-only difference a case difference', () => {
    const hints = diffValueHints(["  +     role: 'User',\n  -     role: 'user',"]);
    expect(hints[0]).toContain('differ only in letter case');
    expect(hints[0]).not.toContain('explicit mapping');
  });
  it('ignores unpaired lines and different keys, and de-duplicates', () => {
    expect(diffValueHints(["  +     a: 1,\n  -     b: 2,"])).toEqual([]);
    expect(diffValueHints(["  +     role: 'X',\n  -     role: 'y',\n  +     role: 'X',\n  -     role: 'y',"])).toHaveLength(1);
  });
  it('reaches the brief', () => {
    const brief = buildRepairBrief({ command: 'node t.js', exitCode: 1, outputTail: OUTPUT.replace("role: 'user'", "role: 'assistant'"), patchedFiles: [] });
    expect(brief).toContain('explicit mapping');
  });
});
