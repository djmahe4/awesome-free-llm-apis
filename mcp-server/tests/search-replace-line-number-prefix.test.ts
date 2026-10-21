import { describe, it, expect } from 'vitest';
import { findLineBlockMatch, applySearchReplaceBlocks } from '../src/tools/coding-agents.js';

// Reproduces a real live failure: context-gatherer.ts formats grep excerpts
// shown to the model as `L${line}: ${content}` (context-gatherer.ts:418).
// The model echoed that presentation-only annotation into a SEARCH/REPLACE
// block's actual content — "L268: const callResult = ..." — which the exact
// file has no literal match for (it's just the code, no "L268: " prefix).
// Root-caused via chat-logs.json for coding_agents session dispatch-fix-v2.

describe('findLineBlockMatch — line-number-prefix tolerance', () => {
  it('finds no match via exact/trimmed tiers when SEARCH carries a bogus L<N>: prefix', () => {
    const working = ['const x = 1;', 'const callResult = await runResearchStep(a, b);', 'const y = 2;'];
    const search = ['L268: const callResult = await runResearchStep(a, b);'];
    const result = findLineBlockMatch(working, search);
    expect(result.index).toBe(1);
    expect(result.usedLineNumberStrip).toBe(true);
  });

  it('does not misfire the line-number tier when SEARCH has no such prefix (real content just happens to differ)', () => {
    const working = ['const a = 1;'];
    const search = ['const b = 2;'];
    const result = findLineBlockMatch(working, search);
    expect(result.index).toBe(-1);
    expect(result.usedLineNumberStrip).toBe(false);
  });

  it('exact tier still wins when no prefix is present (no regression)', () => {
    const working = ['foo();', 'bar();'];
    const search = ['bar();'];
    const result = findLineBlockMatch(working, search);
    expect(result.index).toBe(1);
    expect(result.usedLineNumberStrip).toBe(false);
  });
});

describe('applySearchReplaceBlocks — line-number-prefix tolerance', () => {
  it('applies a block whose SEARCH/REPLACE both carry the bogus L<N>: prefix, stripping it from the inserted text (the exact live failure)', () => {
    const content = [
      '  const callResult = await runResearchStep(store, run, decl, role, input.goal, input.workspaceRoot, registryKey);',
    ].join('\n');
    const blocks = [{
      search: 'L268: const callResult = await runResearchStep(store, run, decl, role, input.goal, input.workspaceRoot, registryKey);',
      replace: 'L268: const callResult = await runRoleStep(store, run, decl, role, input.goal, input.workspaceRoot, registryKey);',
    }];
    const { content: result, appliedCount, failures } = applySearchReplaceBlocks(content, blocks);
    expect(failures).toEqual([]);
    expect(appliedCount).toBe(1);
    expect(result).not.toContain('L268:'); // the bogus annotation must not leak into the real file
    expect(result).toContain('runRoleStep(store, run, decl, role, input.goal, input.workspaceRoot, registryKey);');
    expect(result).not.toContain('runResearchStep');
  });

  it('still fails cleanly (no false match) when SEARCH text is simply wrong, not L<N>:-prefixed', () => {
    const content = 'const x = 1;';
    const blocks = [{ search: 'const x = 2;', replace: 'const x = 3;' }];
    const { appliedCount, failures } = applySearchReplaceBlocks(content, blocks);
    expect(appliedCount).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not found');
  });
});
