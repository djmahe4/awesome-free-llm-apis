import { listModelProfiles, rankProfiles, type ModelProfile } from '../services/model-router.js';
import { quantumTool } from '../tools/quantum-tool.js';

export const LAYA_MODEL = 'laya:421m-typed-decisions-bf16';

export type AlignmentResult = 'aligned' | 'tangential' | 'drift' | 'not_available';

export interface LayaValidationResult {
  alignment: AlignmentResult;
  drift_prob: number;
  unsafe_prob: number;
  latency_ms: number;
}

export interface LayaBridgeDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  profiles?: ModelProfile[];
}

const NOT_AVAILABLE: LayaValidationResult = { alignment: 'not_available', drift_prob: 0, unsafe_prob: 0, latency_ms: 0 };

function resolveBaseUrl(deps?: LayaBridgeDeps): string {
  const raw = deps?.baseUrl ?? process.env.OLLAMA_LOCAL_BASE_URL ?? 'http://localhost:11434';
  return raw.replace(/\/+$/, '');
}

async function resolveModel(deps?: LayaBridgeDeps): Promise<string> {
  try {
    const profiles = deps?.profiles ?? await listModelProfiles(deps?.baseUrl ? { baseUrl: deps.baseUrl } : {});
    const best = rankProfiles(profiles, 'decision').find(r => r.fitsBudget && r.score > 0);
    if (best) return best.name;
  } catch {
  }
  return LAYA_MODEL;
}

export async function validateThoughtDeviation(
  input: { goal: string; trace: Array<{ text: string }>; proposed: string },
  deps?: LayaBridgeDeps,
): Promise<LayaValidationResult> {
  const state = JSON.stringify({ goal: input.goal, recent: input.trace.slice(-3), proposed: input.proposed });
  const model = await resolveModel(deps);
  const body = {
    model,
    state,
    questions: {
      alignment: {
        type: 'choice',
        instructions: 'Does proposed action advance the goal?',
        criteria: { aligned: 'directly advances', tangential: 'off but related', drift: 'contradicts or diverges' },
      },
      unsafe: { type: 'noul', instructions: 'Does proposed action have destructive side effects?' },
    },
  };
  const t0 = Date.now();
  try {
    const doFetch = deps?.fetchImpl ?? fetch;
    const res = await doFetch(`${resolveBaseUrl(deps)}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NOT_AVAILABLE;
    const json: any = await res.json();
    const a = json?.answers?.alignment;
    const unsafe = json?.answers?.unsafe;
    if (!a || !unsafe) return NOT_AVAILABLE;
    const drift_prob = Number(a.probabilities?.drift ?? 0);
    const unsafe_prob = Number(unsafe.noul ?? 0);
    const choice = (a.choice ?? 'tangential') as AlignmentResult;
    return {
      alignment: choice,
      drift_prob: Number.isFinite(drift_prob) ? drift_prob : 0,
      unsafe_prob: Number.isFinite(unsafe_prob) ? unsafe_prob : 0,
      latency_ms: Date.now() - t0,
    };
  } catch {
    return NOT_AVAILABLE;
  }
}

export function enforceDeviationPolicy(
  result: LayaValidationResult,
): 'proceed' | 'replan' | 'halt' | 'require_review' {
  if (result.alignment === 'not_available') return 'proceed';
  if (result.drift_prob > 0.5) return 'halt';
  if (result.unsafe_prob > 0.4) return 'require_review';
  if (result.alignment === 'tangential') return 'replan';
  return 'proceed';
}

export async function quantumOracleScore(thoughts: string[]): Promise<number | null> {
  if (!thoughts.length) return null;
  const sessionId = `oracle-${Date.now()}`;
  try {
    const setup = await quantumTool({
      action: 'setup',
      sessionId,
      numBranches: Math.min(thoughts.length, 8),
      presetCircuit: 'entangled_verification',
    });
    if (!setup.success) return null;
    const analyzed = await quantumTool({
      action: 'analyze',
      sessionId,
      query: thoughts.slice(0, 3).join('\n'),
    });
    const branches: Array<{ confidence: number }> = (analyzed as any)?.state?.branches ?? [];
    if (!branches.length) return null;
    return branches.reduce((s, b) => s + (b.confidence ?? 0), 0) / branches.length;
  } catch {
    return null;
  }
}
