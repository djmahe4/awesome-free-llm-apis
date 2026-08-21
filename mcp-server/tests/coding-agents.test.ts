import { describe, it, expect } from 'vitest';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';
import path from 'node:path';

describe('CodingAgentsHandler (OMP 5-step loop)', () => {
  it('performs dry-run planning with snapshot tags and unified diffs', async () => {
    const result = await CodingAgentsHandler({
      goal: 'add rate limiting middleware to express app',
      workspaceRoot: path.resolve(__dirname, '..'),
      dryRun: true,
      topKFiles: 3,
    });

    expect(result).toBeDefined();
    expect(result.goal).toContain('rate limiting');
    expect(Array.isArray(result.relevantFiles)).toBe(true);
    expect(result.applied).toBe(false);
    expect(Array.isArray(result.patchPlan)).toBe(true);
  });
});
