import type { Proposer } from './hypothesis-gate.js';

export type Llm = (req: Record<string, unknown>) => Promise<any>;

export async function defaultLlm(): Promise<Llm> {
  return async (req: Record<string, unknown>) => {
    // 1st priority: local models via Ollama
    try {
      const { listLocalModels, rankCandidateModels, chatLocal } = await import('../../providers/ollama-local.js');
      const models = await listLocalModels();
      const ranked = rankCandidateModels(models);
      if (ranked.length > 0) {
        const model = ranked[0];
        const messages = (req.messages || []) as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        const temperature = typeof req.temperature === 'number' ? req.temperature : 0.7;
        const res = await chatLocal(model, messages, { temperature });
        if (res && typeof res.content === 'string') {
          return { choices: [{ message: { content: res.content } }] };
        }
      }
    } catch {
      // Local model unavailable or error; fall through to cloud LLMs
    }

    // 2nd priority fallback: useFreeLLM
    const { useFreeLLM } = await import('../use-free-llm.js');
    return (useFreeLLM as unknown as Llm)(req);
  };
}

function textOf(res: any): string {
  const raw = res?.choices?.[0]?.message?.content || res?.content || (typeof res === 'string' ? res : '');
  return typeof raw === 'string' ? raw : '';
}

const PROBE_HELP = [
  'Probe forms (use only these):',
  '  file:<path>                      the file exists',
  '  defined:<name>                   the name is defined in some source file',
  '  symbol:<name>@<path>             the name is defined in that file',
  '  arity:<name>@<path>=<count>      the function takes that many parameters',
  '  grep:<regex>@<path>              the pattern matches a line of that file (must be specific)',
].join('\n');

export function parseValidatorClaims(text: string): Array<{ claim: string; probe: string; status?: unknown }> {
  try {
    const raw = String(text ?? '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, any> => Boolean(x && typeof x === 'object' && typeof x.probe === 'string'))
      .map(x => ({
        claim: typeof x.claim === 'string' ? x.claim : '',
        probe: String(x.probe),
        ...(x.status !== undefined ? { status: x.status } : {}),
      }))
      .slice(0, 12);
  } catch {
    return [];
  }
}

export function makeSubagentValidator(workspaceRoot: string, sessionId: string, llm?: Llm, scopedFiles?: string[]): Proposer {
  return async ({ goal, files, derived }) => {
    try {
      const call = llm ?? (await defaultLlm());
      const prompt = [
        'You are an adversarial validator. Critically challenge the following coding goal to detect hidden or broken assumptions.',
        'If more context is needed across caller or test files, generate probes targeting those specific files or symbols.',
        'List up to 6 skeptical assumptions or potential failure modes this goal depends on that can be verified against the source files, each with an exact probe.',
        'Return ONLY a JSON array: [{ "claim": "<adversarial challenge/assumption>", "probe": "<probe>" }]. No prose, no code fence.',
        'Do not repeat these checks that already exist:',
        derived.map(h => `- ${h.probe}`).join('\n') || '(none)',
        PROBE_HELP,
        `## Goal\n${goal}`,
        `## Files in the workspace\n${(scopedFiles && scopedFiles.length > 0 ? scopedFiles : files).slice(0, 60).join('\n') || '(none listed)'}`,
      ].join('\n\n');

      const res = await call({
        messages: [
          {
            role: 'system',
            content: 'You are a skeptical, adversarial validator. Your role is to challenge assumptions, detect hidden or broken premises, and probe edge cases in proposed coding goals. Output strict JSON only.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        taskType: 'reasoning',
        workspace_root: workspaceRoot,
        sessionId,
        isOnePass: true,
        skipIndexing: true,
        temperature: 0.7,
      });

      return parseValidatorClaims(textOf(res));
    } catch {
      return [];
    }
  };
}
