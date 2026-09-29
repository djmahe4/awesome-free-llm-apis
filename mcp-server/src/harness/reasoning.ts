// Pluggable strategy interface for trial-and-error learning: how the harness
// picks its next move after a step fails, and how it scores conflicting
// findings. See docs/plans/2026-09-29-harness-p4-subagents-brain.md (D5).

export interface StepFailure {
  runId: string;
  role: string;
  tool: string;
  action?: string;
  failureKind: 'tool_error' | 'empty_result' | 'schema_invalid' | 'low_confidence';
  detail: string;
  attempt: number;
}

export interface LessonNode {
  id: string;
  role: string;
  tool: string;
  failureKind: StepFailure['failureKind'];
  strategy: string;
  retention: number;
}

export interface StrategyChoice {
  strategy: string;
  rationale: string;
  args: Record<string, unknown>;
}

export interface Finding {
  claim: string;
  source: string;
  depth: 'abstract' | 'html' | 'pdf' | 'memory';
}

export interface ReasoningStrategy {
  /** Given a step failure and any known past lessons for this role+tool, propose ranked alternative strategies to try next (trial-and-error). Must return at least one choice — a strategy that just retries unchanged is a valid fallback choice. */
  planAlternatives(failure: StepFailure, lessons: LessonNode[]): Promise<StrategyChoice[]>;
  /** Given a set of findings that may conflict, return each finding's claim paired with a 0..1 confidence score, highest first. */
  scoreHypotheses(findings: Finding[]): Promise<{ claim: string; score: number }[]>;
}

/** Deterministic, no LLM calls, no I/O — the default strategy used today. */
export class HeuristicStrategy implements ReasoningStrategy {
  async planAlternatives(failure: StepFailure, lessons: LessonNode[]): Promise<StrategyChoice[]> {
    const reusable = lessons.find(l => l.strategy !== failure.failureKind && l.retention > 0.3);
    if (reusable) {
      return [{
        strategy: reusable.strategy,
        rationale: 'reusing a strategy that previously worked with retention above threshold',
        args: {},
      }];
    }

    switch (failure.failureKind) {
      case 'tool_error':
      case 'empty_result':
        return [
          { strategy: 'retry-same', rationale: 'transient failure, retry unchanged', args: {} },
          { strategy: 'retry-with-backoff', rationale: 'transient failure, retry unchanged', args: {} },
        ];
      case 'schema_invalid':
        return [
          { strategy: 'stricter-json-instruction', rationale: 'reinforce output format constraints', args: {} },
        ];
      case 'low_confidence':
        return [
          { strategy: 'escalate-depth', rationale: 'insufficient evidence at current research depth, escalate to the next depth level', args: {} },
        ];
      default:
        return [{ strategy: 'retry-same', rationale: 'unknown failure kind, retry unchanged', args: {} }];
    }
  }

  async scoreHypotheses(findings: Finding[]): Promise<{ claim: string; score: number }[]> {
    const scored = findings.map(f => {
      let score = 0.5;
      const looksLikeUrl = typeof f.source === 'string' && (f.source.startsWith('http://') || f.source.startsWith('https://') || f.source.startsWith('pdf://'));
      if (looksLikeUrl) score += 0.3;
      if (f.depth === 'pdf' || f.depth === 'memory') score += 0.2;
      return { claim: f.claim, score: Math.min(1, score) };
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}

// TODO: wire real quantum_tool orchestration here — `setup` with
// presetCircuit 'adversarial_debate' (weigh conflicting findings against
// each other) or 'grover_amplification' (amplify the strategy most likely
// to succeed across simulated branches), then `analyze` to synthesize a
// ranked result. Until then this is an intentional passthrough placeholder
// that delegates to the heuristic implementation unchanged.
export class QuantumStrategy implements ReasoningStrategy {
  constructor(private fallback: ReasoningStrategy) {}

  async planAlternatives(failure: StepFailure, lessons: LessonNode[]): Promise<StrategyChoice[]> {
    return this.fallback.planAlternatives(failure, lessons);
  }

  async scoreHypotheses(findings: Finding[]): Promise<{ claim: string; score: number }[]> {
    return this.fallback.scoreHypotheses(findings);
  }
}

export function createReasoningStrategy(kind: 'heuristic' | 'quantum'): ReasoningStrategy {
  return kind === 'quantum' ? new QuantumStrategy(new HeuristicStrategy()) : new HeuristicStrategy();
}
