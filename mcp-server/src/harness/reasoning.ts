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

/**
 * Real quantum_tool orchestration: the deterministic HeuristicStrategy still
 * GENERATES the candidate strategies/claims (quantum_tool doesn't invent
 * options, it adjudicates between real ones) — this class runs them through
 * a persona-per-candidate circuit (`adversarial_debate` for strategies,
 * `consensus_alignment` for conflicting findings), reads back each branch's
 * measured confidence via `get_state`, and re-ranks by that.
 *
 * Telemetry-gated: `quantumStateMetrics.resolvedBranchesCount` (branches
 * that actually collapsed toward 0/1 rather than sitting in superposition)
 * must be > 0 before the quantum ranking is trusted — an undifferentiated
 * circuit (every branch near 0.5) carries no real signal, and falling back
 * to the heuristic's deterministic order is strictly safer than reordering
 * on noise. Any quantum_tool error/unreachability falls back the same way —
 * trial-and-error must keep working even if the quantum session can't.
 *
 * "Persona modify" capability: after ranking, the winning strategy/claim's
 * persona is reinforced (marked [REINFORCED]) via reset+setup — quantum_tool
 * has no in-place persona edit, so a fresh circuit seeded with the updated
 * personas is the real mechanism for carrying a prior forward.
 */
export class QuantumStrategy implements ReasoningStrategy {
  constructor(private fallback: ReasoningStrategy) {}

  private async runDebate(
    sessionId: string,
    personas: string[],
    presetCircuit: 'adversarial_debate' | 'consensus_alignment',
    query: string
  ): Promise<{ branches: Array<{ persona: string; confidence: number }>; resolved: boolean } | null> {
    try {
      const { quantumTool } = await import('../tools/quantum-tool.js');
      await quantumTool({ action: 'setup', sessionId, numBranches: personas.length, personas, presetCircuit });
      await quantumTool({ action: 'step', sessionId });
      await quantumTool({ action: 'analyze', sessionId, query });
      const stateResult: any = await quantumTool({ action: 'get_state', sessionId });
      if (!stateResult?.success || !stateResult.state?.branches) return null;

      const resolvedCount: number = stateResult.telemetry?.quantumStateMetrics?.resolvedBranchesCount ?? 0;
      return {
        branches: stateResult.state.branches.map((b: any) => ({ persona: b.persona, confidence: b.confidence })),
        resolved: resolvedCount > 0,
      };
    } catch {
      return null; // quantum_tool unreachable/failed — caller falls back to the heuristic
    }
  }

  /** Reinforces the winning persona for a future circuit on the same reasoning thread — quantum_tool's real substitute for in-place persona editing. */
  private async reinforcePersona(sessionId: string, personas: string[], winningIndex: number, presetCircuit: 'adversarial_debate' | 'consensus_alignment'): Promise<void> {
    try {
      const { quantumTool } = await import('../tools/quantum-tool.js');
      const reinforced = personas.map((p, i) => (i === winningIndex ? `[REINFORCED] ${p}` : p));
      await quantumTool({ action: 'reset', sessionId });
      await quantumTool({ action: 'setup', sessionId, numBranches: reinforced.length, personas: reinforced, presetCircuit });
    } catch {
      // Best-effort — a failed reinforcement just means the next call starts fresh, not a functional failure.
    }
  }

  async planAlternatives(failure: StepFailure, lessons: LessonNode[]): Promise<StrategyChoice[]> {
    const candidates = await this.fallback.planAlternatives(failure, lessons);
    if (candidates.length <= 1) return candidates; // nothing to adjudicate between

    const sessionId = `harness-reasoning:${failure.runId}:${failure.role}:${failure.tool}`;
    const personas = candidates.map(c => `Strategy advocate for "${c.strategy}": ${c.rationale}`);
    const debate = await this.runDebate(
      sessionId, personas, 'adversarial_debate',
      `Failure "${failure.failureKind}": ${failure.detail} (attempt ${failure.attempt}). Which strategy is most likely to succeed on the next attempt?`
    );
    if (!debate || !debate.resolved) return candidates; // no real signal — keep the deterministic order

    const ranked = [...candidates].sort((a, b) => {
      const ca = debate.branches.find(br => br.persona.includes(`"${a.strategy}"`))?.confidence ?? 0;
      const cb = debate.branches.find(br => br.persona.includes(`"${b.strategy}"`))?.confidence ?? 0;
      return cb - ca;
    });

    const winnerIdx = candidates.findIndex(c => c.strategy === ranked[0].strategy);
    if (winnerIdx >= 0) await this.reinforcePersona(sessionId, personas, winnerIdx, 'adversarial_debate');

    return ranked;
  }

  async scoreHypotheses(findings: Finding[]): Promise<{ claim: string; score: number }[]> {
    const heuristicScores = await this.fallback.scoreHypotheses(findings);
    if (findings.length <= 1) return heuristicScores;

    const sessionId = `harness-reasoning:findings:${findings.map(f => f.claim).join('|').slice(0, 64)}`;
    const personas = findings.map(f => `Claim advocate: "${f.claim}" (source: ${f.source}, depth: ${f.depth})`);
    const debate = await this.runDebate(
      sessionId, personas, 'consensus_alignment',
      'Which of these claims is best supported by its evidence and should be trusted most?'
    );
    if (!debate || !debate.resolved) return heuristicScores; // no real signal — keep the deterministic heuristic scores

    // Blend rather than replace: quantum_tool adjudicates relative confidence,
    // the heuristic already grounds absolute score in source/depth quality.
    const blended = heuristicScores.map(h => {
      const idx = findings.findIndex(f => f.claim === h.claim);
      const persona = idx >= 0 ? personas[idx] : undefined;
      const quantumConfidence = persona ? debate.branches.find(br => br.persona === persona)?.confidence : undefined;
      const score = quantumConfidence === undefined ? h.score : Math.min(1, (h.score + quantumConfidence) / 2);
      return { claim: h.claim, score };
    }).sort((a, b) => b.score - a.score);

    const winnerIdx = findings.findIndex(f => f.claim === blended[0].claim);
    if (winnerIdx >= 0) await this.reinforcePersona(sessionId, personas, winnerIdx, 'consensus_alignment');

    return blended;
  }
}

export function createReasoningStrategy(kind: 'heuristic' | 'quantum'): ReasoningStrategy {
  return kind === 'quantum' ? new QuantumStrategy(new HeuristicStrategy()) : new HeuristicStrategy();
}
