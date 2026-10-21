import { describe, it, expect } from 'vitest';
import { extractWindowForInstruction } from '../src/tools/coding-agents.js';

// Real live failure (coding_agents session silentzero-v1): an instruction
// containing a verbatim FIND/REPLACE block for a multi-line target function
// (applyResearchResult) got windowed onto a completely unrelated one-liner
// (finalizeRun's registryError ternary) instead, because that single line
// packed several instruction keywords ("status"/"complete"/"failed") onto
// one line, outscoring the real target whose matching keywords were spread
// across several lines. The model, shown the wrong window, hallucinated an
// edit to the only thing visible — it applied cleanly (real text, no TS
// regression) and reported success while completely missing the goal.

describe('extractWindowForInstruction — keyword-density window selection', () => {
  it('does not let one keyword-dense unrelated line outscore a multi-line real target', () => {
    const filler = Array.from({ length: 80 }, (_, i) => `const unrelated${i} = ${i};`);
    const lines = [
      ...filler,
      // dense decoy: packs status/complete/failed onto one line
      "const registryError = run.status === 'complete' ? undefined : run.status === 'failed' ? run.error : 'x';",
      ...filler,
      // real target: same keywords, spread across several lines
      'function applyResearchResult(run, role, callResult, goalTokens, aborted) {',
      "  const content = callResult.result?.choices?.[0]?.message?.content ?? '';",
      '  run.result = content;',
      "  run.status = 'complete';",
      '  return { content };',
      '}',
      ...filler,
    ];
    const content = lines.join('\n');
    const instruction = "find applyResearchResult and change run.status = 'complete' so an empty content result is treated as failed, not complete";

    const result = extractWindowForInstruction(content, instruction, 40);
    expect(result).not.toBeNull();
    expect(result!.window).toContain('function applyResearchResult');
  });
});
