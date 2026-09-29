import { describe, it, expect } from 'vitest';
import { HeuristicStrategy, QuantumStrategy, createReasoningStrategy, type StepFailure, type LessonNode } from '../src/harness/reasoning.js';

const baseFailure: StepFailure = { runId: 'r1', role: 'researcher', tool: 'use_free_llm', failureKind: 'tool_error', detail: 'timeout', attempt: 1 };

describe('HeuristicStrategy.planAlternatives', () => {
  const strategy = new HeuristicStrategy();

  it('proposes retry-same then retry-with-backoff for tool_error with no lessons', async () => {
    const choices = await strategy.planAlternatives(baseFailure, []);
    expect(choices[0].strategy).toBe('retry-same');
    expect(choices[1].strategy).toBe('retry-with-backoff');
  });

  it('proposes stricter-json-instruction for schema_invalid', async () => {
    const choices = await strategy.planAlternatives({ ...baseFailure, failureKind: 'schema_invalid' }, []);
    expect(choices[0].strategy).toBe('stricter-json-instruction');
  });

  it('proposes escalate-depth for low_confidence', async () => {
    const choices = await strategy.planAlternatives({ ...baseFailure, failureKind: 'low_confidence' }, []);
    expect(choices[0].strategy).toBe('escalate-depth');
  });

  it('reuses a high-retention lesson over the default failureKind response', async () => {
    const lessons: LessonNode[] = [
      { id: 'l1', role: 'researcher', tool: 'use_free_llm', failureKind: 'tool_error', strategy: 'escalate-depth', retention: 0.6 },
    ];
    const choices = await strategy.planAlternatives(baseFailure, lessons);
    expect(choices).toHaveLength(1);
    expect(choices[0].strategy).toBe('escalate-depth');
  });

  it('ignores a lesson whose retention has decayed below threshold', async () => {
    const lessons: LessonNode[] = [
      { id: 'l1', role: 'researcher', tool: 'use_free_llm', failureKind: 'tool_error', strategy: 'escalate-depth', retention: 0.1 },
    ];
    const choices = await strategy.planAlternatives(baseFailure, lessons);
    expect(choices[0].strategy).toBe('retry-same'); // fell through to the default rule
  });

  it('always returns at least one choice', async () => {
    const choices = await strategy.planAlternatives({ ...baseFailure, failureKind: 'empty_result' }, []);
    expect(choices.length).toBeGreaterThan(0);
  });
});

describe('HeuristicStrategy.scoreHypotheses', () => {
  const strategy = new HeuristicStrategy();

  it('scores a pdf-sourced finding higher than a bare-string-sourced one', async () => {
    const results = await strategy.scoreHypotheses([
      { claim: 'A', source: 'notes.txt', depth: 'abstract' },
      { claim: 'B', source: 'pdf://spec.pdf:3', depth: 'pdf' },
    ]);
    const a = results.find(r => r.claim === 'A')!;
    const b = results.find(r => r.claim === 'B')!;
    expect(b.score).toBeGreaterThan(a.score);
  });

  it('sorts descending by score', async () => {
    const results = await strategy.scoreHypotheses([
      { claim: 'low', source: 'x', depth: 'abstract' },
      { claim: 'high', source: 'https://example.com', depth: 'pdf' },
    ]);
    expect(results[0].claim).toBe('high');
  });

  it('caps score at 1.0', async () => {
    const results = await strategy.scoreHypotheses([{ claim: 'A', source: 'https://x.com', depth: 'pdf' }]);
    expect(results[0].score).toBeLessThanOrEqual(1);
  });
});

describe('QuantumStrategy (stub)', () => {
  it('delegates planAlternatives to its fallback unchanged', async () => {
    const fallback = new HeuristicStrategy();
    const quantum = new QuantumStrategy(fallback);
    const expected = await fallback.planAlternatives(baseFailure, []);
    const actual = await quantum.planAlternatives(baseFailure, []);
    expect(actual).toEqual(expected);
  });

  it('delegates scoreHypotheses to its fallback unchanged', async () => {
    const fallback = new HeuristicStrategy();
    const quantum = new QuantumStrategy(fallback);
    const findings = [{ claim: 'A', source: 'https://x.com', depth: 'html' as const }];
    expect(await quantum.scoreHypotheses(findings)).toEqual(await fallback.scoreHypotheses(findings));
  });
});

describe('createReasoningStrategy', () => {
  it('returns HeuristicStrategy by default', () => {
    expect(createReasoningStrategy('heuristic')).toBeInstanceOf(HeuristicStrategy);
  });

  it('returns QuantumStrategy when requested', () => {
    expect(createReasoningStrategy('quantum')).toBeInstanceOf(QuantumStrategy);
  });
});
