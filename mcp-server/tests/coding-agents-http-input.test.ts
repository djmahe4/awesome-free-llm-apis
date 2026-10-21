import { describe, it, expect } from 'vitest';
import { normalizeCodingAgentsHttpInput } from '../src/tools/coding-agents/http-input.js';

describe('normalizeCodingAgentsHttpInput', () => {
  it('forwards every field, including action, targetFiles, pauseOnTaskPlan, lspAction and astEditOps', () => {
    const body = {
      goal: 'add clear()', action: 'plan', targetFiles: ['src/a.ts'], pauseOnTaskPlan: true,
      lspAction: { type: 'hover' }, astEditOps: [{ op: 'x' }], sessionId: 's1', resolve: { decision: 'approve' },
    };
    const r = normalizeCodingAgentsHttpInput(body, '/ws');
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.input).toMatchObject(body);
  });

  it('applies the documented defaults', () => {
    const r = normalizeCodingAgentsHttpInput({ goal: 'g' }, '/ws');
    if ('error' in r) throw new Error(r.error);
    expect(r.input).toMatchObject({ workspaceRoot: '/ws', dryRun: true, topKFiles: 5, verifyLspDiagnostics: true });
  });

  it('requires a goal for a new run', () => {
    expect(normalizeCodingAgentsHttpInput({}, '/ws')).toEqual({ error: 'goal is required' });
    expect(normalizeCodingAgentsHttpInput({ action: 'execute' }, '/ws')).toEqual({ error: 'goal is required' });
  });

  it('lets status, abort and resume polls omit the goal (they address a session)', () => {
    for (const action of ['status', 'abort', 'resume']) {
      const r = normalizeCodingAgentsHttpInput({ action, sessionId: 's1' }, '/ws');
      expect('error' in r).toBe(false);
    }
  });

  it('rejects an unknown action and a non-object body', () => {
    expect(normalizeCodingAgentsHttpInput({ goal: 'g', action: 'format-disk' }, '/ws')).toMatchObject({ error: expect.stringContaining('action') });
    expect(normalizeCodingAgentsHttpInput(null, '/ws')).toEqual({ error: 'goal is required' });
  });
});

describe('normalizeCodingAgentsHttpInput: verification inputs', () => {
  it('forwards verifyCommand, verifyReport and feedback; a verifyReport needs no goal', () => {
    const r = normalizeCodingAgentsHttpInput({ verifyReport: { exitCode: 1, output: 'FAIL' }, feedback: 'brief', verifyCommand: 'npm test' }, '/ws');
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.input).toMatchObject({ verifyReport: { exitCode: 1, output: 'FAIL' }, feedback: 'brief', verifyCommand: 'npm test' });
  });
});
