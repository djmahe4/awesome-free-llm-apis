import { describe, it, expect } from 'vitest';
import { buildHandoff, validateHandoff } from '../src/harness/handoff.js';

// D2 in docs/plans/2026-09-29-harness-p4-subagents-brain.md: real,
// schema-validated handoffs — replacing the old synthetic one runner.ts
// fabricated once at the end of a run with a hardcoded confidence:0.7.

describe('buildHandoff', () => {
  it('produces a complete, non-empty-confidence handoff for real content', () => {
    const h = buildHandoff('researcher', 'analyst', 'The CAP theorem states...');
    expect(h.status).toBe('complete');
    expect(h.confidence).toBeGreaterThan(0);
    expect(h.confidence).toBeLessThanOrEqual(1);
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0].source).toBe('researcher');
  });

  it('produces a blocked, zero-confidence handoff for empty content — never a fabricated finding', () => {
    const h = buildHandoff('researcher', 'analyst', '');
    expect(h.status).toBe('blocked');
    expect(h.confidence).toBe(0);
    expect(h.findings).toHaveLength(0);
  });

  it('longer content does not exceed confidence 1', () => {
    const h = buildHandoff('researcher', 'analyst', 'x'.repeat(10000));
    expect(h.confidence).toBeLessThanOrEqual(1);
  });
});

describe('validateHandoff', () => {
  it('accepts a well-formed handoff built by buildHandoff', () => {
    const result = validateHandoff(buildHandoff('researcher', 'analyst', 'grounded finding'));
    expect(result.ok).toBe(true);
  });

  it('rejects a handoff missing required fields — malformed, never silently accepted', () => {
    const result = validateHandoff({ from: 'researcher', to: 'analyst' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('rejects confidence outside [0,1]', () => {
    const bad = { ...buildHandoff('a', 'b', 'x'), confidence: 1.5 };
    expect(validateHandoff(bad).ok).toBe(false);
  });

  it('rejects an invalid status enum value', () => {
    const bad = { ...buildHandoff('a', 'b', 'x'), status: 'done' };
    expect(validateHandoff(bad).ok).toBe(false);
  });
});
