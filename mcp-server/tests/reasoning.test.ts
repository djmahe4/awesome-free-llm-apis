import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('QuantumStrategy (real wiring, mocked quantum_tool)', () => {
  const quantumToolMock = vi.fn();

  beforeEach(() => {
    quantumToolMock.mockReset();
    vi.doMock('../src/tools/quantum-tool.js', () => ({ quantumTool: quantumToolMock }));
  });

  it('re-ranks candidates by measured branch confidence when the circuit resolves, and reinforces the winner', async () => {
    const { QuantumStrategy: MockedQuantumStrategy } = await import('../src/harness/reasoning.js');
    const fallback = new HeuristicStrategy();
    const quantum = new MockedQuantumStrategy(fallback);

    // retry-same, retry-with-backoff — retry-with-backoff "wins" the debate.
    quantumToolMock.mockImplementation(async (input: any) => {
      if (input.action === 'get_state') {
        return {
          success: true,
          state: {
            branches: [
              { persona: input.personas?.[0] ?? 'Strategy advocate for "retry-same": transient failure, retry unchanged', confidence: 0.1 },
              { persona: 'Strategy advocate for "retry-with-backoff": transient failure, retry unchanged', confidence: 0.9 },
            ],
          },
          telemetry: { quantumStateMetrics: { resolvedBranchesCount: 2 } },
        };
      }
      return { success: true, sessionId: input.sessionId };
    });

    const choices = await quantum.planAlternatives(baseFailure, []);
    expect(choices[0].strategy).toBe('retry-with-backoff');

    const calls = quantumToolMock.mock.calls.map(c => c[0].action);
    expect(calls).toContain('setup');
    expect(calls).toContain('analyze');
    expect(calls).toContain('reset'); // reinforcePersona fired for the winner
    const lastSetup = quantumToolMock.mock.calls.filter(c => c[0].action === 'setup').pop()![0];
    expect(lastSetup.personas.some((p: string) => p.startsWith('[REINFORCED]') && p.includes('retry-with-backoff'))).toBe(true);
  });

  it('keeps the deterministic heuristic order when the circuit never resolves', async () => {
    const { QuantumStrategy: MockedQuantumStrategy } = await import('../src/harness/reasoning.js');
    const fallback = new HeuristicStrategy();
    const quantum = new MockedQuantumStrategy(fallback);

    quantumToolMock.mockImplementation(async (input: any) => {
      if (input.action === 'get_state') {
        return {
          success: true,
          state: { branches: [{ persona: 'a', confidence: 0.5 }, { persona: 'b', confidence: 0.5 }] },
          telemetry: { quantumStateMetrics: { resolvedBranchesCount: 0 } }, // undifferentiated — no real signal
        };
      }
      return { success: true };
    });

    const expected = await fallback.planAlternatives(baseFailure, []);
    const actual = await quantum.planAlternatives(baseFailure, []);
    expect(actual).toEqual(expected);
  });

  it('falls back safely when quantum_tool throws', async () => {
    const { QuantumStrategy: MockedQuantumStrategy } = await import('../src/harness/reasoning.js');
    const fallback = new HeuristicStrategy();
    const quantum = new MockedQuantumStrategy(fallback);
    quantumToolMock.mockRejectedValue(new Error('session backend unavailable'));

    const expected = await fallback.planAlternatives(baseFailure, []);
    const actual = await quantum.planAlternatives(baseFailure, []);
    expect(actual).toEqual(expected);
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
