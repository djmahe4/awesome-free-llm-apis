import { describe, it, expect } from 'vitest';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import { parseReview, reviewPatch } from '../src/tools/coding-agents/reviewer.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

const notGreen = (brief: string, extra: Partial<CodingAgentsResult> = {}): CodingAgentsResult => ({
  sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: true, checkpointId: 'cp1',
  verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, repairBrief: brief }, ...extra,
});

const base = (extra: Partial<CodingAgentsResult> = {}): CodingAgentsResult => ({
  sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false, ...extra,
});
const regressed = (brief: string) => base({ applied: false, verification: { command: 'c', status: 'regressed', ok: false, baselineOk: true, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, repairBrief: brief } });
const passed = () => base({ applied: true, verification: { command: 'c', status: 'passed', ok: true, baselineOk: true, exitCode: 0, timedOut: false, outputTail: '', durationMs: 1 } });

const input: CodingAgentsInput = { goal: 'implement x', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' } };

describe('runWithRepairLoop', () => {
  it('retries a regression with the debugger brief as feedback and converges', async () => {
    const seen: Array<string | undefined> = [];
    const results = [regressed('expected 1 got 2'), passed()];
    const r = await runWithRepairLoop(input, 's', undefined, async (i) => { seen.push(i.feedback); return results.shift()!; });
    expect(seen).toEqual([undefined, 'expected 1 got 2']);
    expect(r.applied).toBe(true);
    expect(r.repair).toMatchObject({ outcome: 'converged', attemptCount: 2 });
    expect(r.repair!.attempts.map(a => a.outcome)).toEqual(['regressed', 'passed']);
  });

  it('stops after the attempt budget with not_converged and keeps the last brief', async () => {
    let n = 0;
    const r = await runWithRepairLoop({ ...input, maxRepairAttempts: 2 }, 's', undefined, async () => regressed(`failure ${++n}`));
    expect(n).toBe(3); // first try + 2 repairs
    expect(r.repair).toMatchObject({ outcome: 'not_converged', attemptCount: 3 });
    expect(r.applied).toBe(false);
  });

  it('a repeated identical failure first escalates the sampling temperature, then stops as stuck', async () => {
    const temps: Array<number | undefined> = [];
    const r = await runWithRepairLoop({ ...input, maxRepairAttempts: 3 }, 's', undefined, async (i) => { temps.push(i.temperature); return regressed('same brief'); });
    // greedy decoding gives the same answer for the same prompt, so retries must vary the sample
    expect(temps).toEqual([undefined, 0.3, 0.6]);
    expect(r.repair).toMatchObject({ outcome: 'stuck', attemptCount: 3 });
  });

  it('a different failure on the next attempt is progress, not stuck', async () => {
    let n = 0;
    const r = await runWithRepairLoop({ ...input, maxRepairAttempts: 3 }, 's', undefined, async () => regressed(`failure ${++n}`));
    expect(r.repair?.outcome).toBe('not_converged');
    expect(n).toBe(4);
  });

  it('does not loop when there is no verifyCommand, for AST edits, or when the budget is 0', async () => {
    for (const i of [{ ...input, verifyCommand: undefined }, { ...input, astEditOps: [{ pat: 'a', out: 'b' }] }, { ...input, maxRepairAttempts: 0 }] as CodingAgentsInput[]) {
      let n = 0;
      const r = await runWithRepairLoop(i, 's', undefined, async () => { n++; return regressed('x'); });
      expect(n).toBe(1);
      expect(r.repair?.outcome ?? 'none').not.toBe('converged');
    }
  });

  it('never retries a needs_user (withheld or manual-run) result: the human is the next step', async () => {
    let n = 0;
    const r = await runWithRepairLoop(input, 's', undefined, async () => { n++; return base({ verification: { command: 'c', status: 'needs_user', ok: false, baselineOk: false, exitCode: null, timedOut: false, outputTail: '', durationMs: 0, reasons: ['tests changed'] } }); });
    expect(n).toBe(1);
    expect(r.repair?.outcome).toBe('needs_user');
  });

  it('without a verifyCommand a reviewer block is repaired like a failing check', async () => {
    const blocked = base({ review: { verdict: 'blocked', findings: [{ blocking: true, text: 'input 100.64.0.1 expected true actual false' }], brief: 'REVIEW: input 100.64.0.1 expected true actual false' } });
    const seen: Array<string | undefined> = [];
    const results = [blocked, base({ applied: true })];
    const r = await runWithRepairLoop({ ...input, verifyCommand: undefined }, 's', undefined, async (i) => { seen.push(i.feedback); return results.shift()!; });
    expect(seen[1]).toContain('100.64.0.1');
    expect(r.repair?.outcome).toBe('converged');
  });

  it('with a verifyCommand the check is the judge: a reviewer block alone never triggers a retry', async () => {
    const advisory = base({ applied: true, verification: { command: 'c', status: 'passed', ok: true, baselineOk: true, exitCode: 0, timedOut: false, outputTail: '', durationMs: 1 },
      review: { verdict: 'blocked', findings: [{ blocking: true, text: 'input x expected y actual z' }], brief: 'REVIEW: x' } });
    let n = 0;
    const r = await runWithRepairLoop(input, 's', undefined, async () => { n++; return advisory; });
    expect(n).toBe(1);
    expect(r.repair?.outcome).toBe('converged');
  });

  it('when a check fails, the retry gets exactly the debugger brief (the reviewer is not consulted)', async () => {
    const seen: Array<string | undefined> = [];
    const results = [regressed('DEBUGGER: expected 1 got 2'), passed()];
    await runWithRepairLoop(input, 's', undefined, async (i) => { seen.push(i.feedback); return results.shift()!; });
    expect(seen[1]).toBe('DEBUGGER: expected 1 got 2');
  });

  it('a crash inside an attempt is reported, not thrown away', async () => {
    const r = await runWithRepairLoop(input, 's', undefined, async () => { throw new Error('model offline'); }).catch(e => e);
    expect(String(r?.message ?? r?.error ?? r)).toMatch(/model offline/);
  });
});

describe('test-first tasks: the check already fails before the edit', () => {
  it('a still-red result is repaired with the brief, and converges when it goes green', async () => {
    const seen: Array<string | undefined> = [];
    const results = [notGreen('expected true got false'), passed()];
    const r = await runWithRepairLoop(input, 's', undefined, async (i) => { seen.push(i.feedback); return results.shift()!; });
    expect(seen).toEqual([undefined, 'expected true got false']);
    expect(r.repair).toMatchObject({ outcome: 'converged', attemptCount: 2 });
  });

  it('if it never goes green the tree is restored to the original and the result says so', async () => {
    const restored: string[][] = [];
    let n = 0;
    const r = await runWithRepairLoop({ ...input, maxRepairAttempts: 1 }, 's', undefined,
      async () => notGreen(`failure ${++n}`, { checkpointId: `cp${n}`, patchPlan: [{ filePath: 'src/new.js', isNewFile: true } as any] }),
      async (checkpointId, newFiles) => { restored.push([checkpointId, ...newFiles]); return [`restored:${checkpointId}`]; });
    expect(r.repair?.outcome).toBe('not_converged');
    expect(restored).toEqual([['cp1', 'src/new.js']]); // the FIRST attempt's checkpoint = the original tree
    expect(r.applied).toBe(false);
    expect(r.restoredFiles).toEqual(['restored:cp1']);
    expect(r.message).toMatch(/never went green/i);
  });

  it('a regression is not rolled back twice: the gate already did it', async () => {
    const restored: string[] = [];
    await runWithRepairLoop({ ...input, maxRepairAttempts: 0 }, 's', undefined, async () => regressed('x'), async (id) => { restored.push(id); return []; });
    expect(restored).toEqual([]);
  });
});

describe('rewrite mode on retries', () => {
  const many = (extra: Partial<CodingAgentsResult> = {}) => notGreen('brief', { verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, repairBrief: 'brief', failedCases: ['a', 'b', 'c', 'd'] }, ...extra });
  const few = () => notGreen('brief', { verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, repairBrief: 'brief', failedCases: ['a'] } });

  it('rewrites after a run with several failing cases, but patches again from a near-miss', async () => {
    const seen: Array<boolean | undefined> = [];
    const rolledBack: number[] = [];
    const results = [many(), few(), passed()];
    await runWithRepairLoop({ ...input, maxRepairAttempts: 3 }, 's', undefined,
      async (i) => { seen.push(i.rewrite); return results.shift()!; },
      async () => { rolledBack.push(seen.length); return []; });
    // attempt 2 is a rewrite (from the original); attempt 3 patches attempt 2's near-miss in place
    expect(seen).toEqual([undefined, true, undefined]);
    expect(rolledBack).toEqual([1]);
  });

  it('a rewrite starts from the ORIGINAL file: the failed attempt is rolled back first, otherwise the model just copies its own broken code', async () => {
    const order: string[] = [];
    const results = [many({ checkpointId: 'cp-original' }), passed()];
    await runWithRepairLoop({ ...input, maxRepairAttempts: 2 }, 's', undefined,
      async (i) => { order.push(`run(rewrite=${i.rewrite})`); return results.shift()!; },
      async (id) => { order.push(`rollback(${id})`); return []; });
    expect(order).toEqual(['run(rewrite=undefined)', 'rollback(cp-original)', 'run(rewrite=true)']);
  });

  it('without a rollback available a rewrite is not attempted (it would copy the broken file)', async () => {
    const seen: Array<boolean | undefined> = [];
    const results = [many(), passed()];
    await runWithRepairLoop({ ...input, maxRepairAttempts: 2 }, 's', undefined, async (i) => { seen.push(i.rewrite); return results.shift()!; });
    expect(seen).toEqual([undefined, undefined]);
  });

  it('keeps patching when only one or two cases fail', async () => {
    const seen: Array<boolean | undefined> = [];
    const results = [few(), passed()];
    await runWithRepairLoop(input, 's', undefined, async (i) => { seen.push(i.rewrite); return results.shift()!; });
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe('parseReview', () => {
  it('blocks only on a finding that cites a concrete input, expected and actual', () => {
    const text = [
      'BLOCK | input: 100.64.0.1 | expected: true | actual: false | why: wrong octet for the CGNAT range',
      'NOTE | the function could use a table for readability',
      'BLOCK | looks risky',
    ].join('\n');
    const r = parseReview(text);
    expect(r.verdict).toBe('blocked');
    expect(r.findings.filter(f => f.blocking)).toHaveLength(1);
    expect(r.findings.filter(f => !f.blocking)).toHaveLength(2);
    expect(r.brief).toContain('100.64.0.1');
  });
  it('OK, empty and unparsable replies are not blocks', () => {
    expect(parseReview('OK').verdict).toBe('ok');
    expect(parseReview('').verdict).toBe('ok');
    expect(parseReview('I think this is fine overall, nice work!').verdict).toBe('ok');
  });
  it('vague blocks become notes: reported but they do not stop the edit', () => {
    const r = parseReview('BLOCK | might be wrong somewhere');
    expect(r.verdict).toBe('concerns');
    expect(r.findings[0].blocking).toBe(false);
  });
});

describe('reviewPatch', () => {
  it('shows the model only the instruction and the diff, and parses its verdict', async () => {
    let prompt = '';
    const r = await reviewPatch({ instruction: 'cap at 20', diff: '+ return Math.min(x, 20)', chat: async (p) => { prompt = p; return 'OK'; } });
    expect(r.verdict).toBe('ok');
    expect(prompt).toContain('cap at 20');
    expect(prompt).toContain('Math.min(x, 20)');
    expect(prompt).not.toMatch(/workspace|api key|password/i);
  });
  it('a failing reviewer never blocks the edit', async () => {
    const r = await reviewPatch({ instruction: 'x', diff: 'y', chat: async () => { throw new Error('offline'); } });
    expect(r.verdict).toBe('skipped');
    expect(r.findings).toEqual([]);
  });
  it('bounds the diff it sends', async () => {
    let prompt = '';
    await reviewPatch({ instruction: 'x', diff: 'line\n'.repeat(5000), chat: async (p) => { prompt = p; return 'OK'; } });
    expect(prompt.length).toBeLessThan(9000);
  });
});
