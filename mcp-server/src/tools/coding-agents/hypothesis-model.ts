import type { Proposer, Reviser } from './hypothesis-gate.js';

/**
 * The model-backed halves of the gate (settings: hypothesisModel). The model only proposes claims with probes and one
 * corrected goal; every probe result is computed from the files (see hypothesis-gate.ts), never taken from the model.
 */

type Llm = (req: Record<string, unknown>) => Promise<any>;

async function defaultLlm(): Promise<Llm> {
  const { useFreeLLM } = await import('../use-free-llm.js');
  return useFreeLLM as unknown as Llm;
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

export function modelProposer(workspaceRoot: string, sessionId: string, llm?: Llm): Proposer {
  return async ({ goal, files, derived }) => {
    const call = llm ?? await defaultLlm();
    const prompt = [
      'List up to 6 factual assumptions this coding goal depends on that could be checked against the source files, each with a probe.',
      'Return ONLY a JSON array: [{ "claim": "<one sentence>", "probe": "<probe>" }]. No prose, no code fence.',
      'Do not repeat these checks that already exist:',
      derived.map(h => `- ${h.probe}`).join('\n') || '(none)',
      PROBE_HELP,
      `## Goal\n${goal}`,
      `## Files in the workspace\n${files.slice(0, 60).join('\n') || '(none listed)'}`,
    ].join('\n\n');
    const res = await call({
      messages: [
        { role: 'system', content: 'You check plans against code. Output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      taskType: 'reasoning', workspace_root: workspaceRoot, sessionId, isOnePass: true, skipIndexing: true,
    });
    const match = textOf(res).match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter(x => x && typeof x.probe === 'string').slice(0, 12) : [];
  };
}

export function modelReviser(workspaceRoot: string, sessionId: string, llm?: Llm): Reviser {
  return async ({ goal, refuted }) => {
    const call = llm ?? await defaultLlm();
    const prompt = [
      'The workspace contradicts these assumptions in the goal below. Rewrite the goal so it matches what the workspace actually contains.',
      'Change only what the evidence requires. Return ONLY the corrected goal text, no commentary.',
      '## Refuted assumptions',
      refuted.map(h => `- ${h.claim}: ${h.evidence}`).join('\n'),
      `## Goal\n${goal}`,
    ].join('\n\n');
    const res = await call({
      messages: [
        { role: 'system', content: 'You correct a coding goal using evidence from the workspace. Output the corrected goal only.' },
        { role: 'user', content: prompt },
      ],
      taskType: 'reasoning', workspace_root: workspaceRoot, sessionId, isOnePass: true, skipIndexing: true,
    });
    return textOf(res).trim().replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
  };
}
