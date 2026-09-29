import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/harness/policy.js';
import type { HarnessDeclaration } from '../src/harness/types.js';

// constraintsMatch (policy.ts) previously did strict equality only, so a rule
// couldn't express "tag is one of these allowed values" — only "tag equals
// exactly this one value". This covers the array-membership branch that
// unlocks skill-tag allowlisting (docs/harness-cyber.md priority 3).

function declWithConstraint(constraints: Record<string, unknown>): HarnessDeclaration {
  return {
    harness: {
      name: 'test-harness',
      schemaVersion: 1,
      primaryLane: 'research',
      budget: { maxTokens: 10000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 1 },
      approval: { timeoutMinutes: 10, standingRules: [] },
    },
    roles: {
      researcher: {
        tools: [{ tool: 'execute_skill', constraints }],
      },
    },
    writes: [],
    contentDepth: { order: ['low'], default: 'low' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.5, maxDepth: 1 },
  } as HarnessDeclaration;
}

describe('policy constraintsMatch — array-membership', () => {
  it('allows when args field is a scalar present in the constraint array', () => {
    const decl = declWithConstraint({ skillTag: ['cyber', 'osint'] });
    const decision = evaluate(decl, 'researcher', 'execute_skill', undefined, { skillTag: 'cyber' });
    expect(decision.kind).toBe('allow');
  });

  it('denies (needs_approval) when scalar args field is not in the constraint array', () => {
    const decl = declWithConstraint({ skillTag: ['cyber', 'osint'] });
    const decision = evaluate(decl, 'researcher', 'execute_skill', undefined, { skillTag: 'general' });
    expect(decision.kind).toBe('needs_approval');
  });

  it('allows when args field is an array intersecting the constraint array', () => {
    const decl = declWithConstraint({ skillTags: ['cyber'] });
    const decision = evaluate(decl, 'researcher', 'execute_skill', undefined, { skillTags: ['general', 'cyber'] });
    expect(decision.kind).toBe('allow');
  });

  it('denies when args array has no overlap with the constraint array', () => {
    const decl = declWithConstraint({ skillTags: ['cyber'] });
    const decision = evaluate(decl, 'researcher', 'execute_skill', undefined, { skillTags: ['general'] });
    expect(decision.kind).toBe('needs_approval');
  });

  it('denies when args array is empty', () => {
    const decl = declWithConstraint({ skillTags: ['cyber'] });
    const decision = evaluate(decl, 'researcher', 'execute_skill', undefined, { skillTags: [] });
    expect(decision.kind).toBe('needs_approval');
  });

  it('non-array constraints still behave as strict equality (no regression)', () => {
    const decl = declWithConstraint({ skill: 'general-purpose' });
    const allowed = evaluate(decl, 'researcher', 'execute_skill', undefined, { skill: 'general-purpose' });
    const denied = evaluate(decl, 'researcher', 'execute_skill', undefined, { skill: 'other' });
    expect(allowed.kind).toBe('allow');
    expect(denied.kind).toBe('needs_approval');
  });
});
