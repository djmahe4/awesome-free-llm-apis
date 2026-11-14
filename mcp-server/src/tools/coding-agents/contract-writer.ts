import { readVerifyTestContext } from './verify-guard.js';
import { buildExternalContext } from '../../harness/external-context.js';
import { validateContractBullets, type CallSite } from './call-sites.js';
import type { CodingAgentsInput } from './types.js';

/**
 * Contract writer (opt-in: CodingAgentsInput.contractModel).
 *
 * A small coding model rebuilding a module from its tests gets the call shapes wrong (`messages` as an array where the test
 * passes `{ messages: [...] }`) even when the tests are in its prompt. The deterministic part of the answer is in call-sites.ts
 * (the tests' calls, copied literally). This adds what only a reader can say, the return shapes and the null/throw cases: a
 * larger local model reads the tests (and, with contextDirs, the real data shape) and writes one bullet per export.
 *
 * A model can be wrong (a 9B thinking model once wrote `buildThing(messages: any[])` for a three-argument call and the editor
 * followed it), so every bullet is checked against the tests' call sites and dropped when its argument count or shape
 * contradicts them. The writer never writes code and never sees the target's current content, runs locally (chatLocal), and is
 * skipped, never faked, when the model is not installed.
 */

export type ChatFn = (model: string, messages: Array<{ role: 'system' | 'user'; content: string }>, options: { temperature: number; maxTokens: number; think: boolean }) => Promise<{ content: string }>;

const SYSTEM = 'You read tests and describe how each exported function is called and what it returns. Reply with plain bullet points only: no code fences, no implementation, no commentary.';

export function contractPrompt(opts: { target: string; names: string[]; testSpec: string; shapes?: string }): string {
  return [
    `Module under test: ${opts.target}`,
    `Exports to describe: ${opts.names.join(', ')}`,
    'For EACH export write one bullet that starts with "- <name>(" and states: the arguments in order with their exact types or object shapes as the tests pass them, what it returns (type and shape), and when it returns null or throws, as far as the tests show. Use only facts visible in the tests or in the data shape below.',
    opts.testSpec,
    ...(opts.shapes ? [`Real shape of the data the module reads (structure only):\n${opts.shapes}`] : []),
  ].join('\n\n');
}

/** Keeps only the bullets that name an export, drops fences, and caps the length. Returns the bullets one per line. */
export function cleanContract(reply: string, names: string[], maxChars = 1600): string {
  const bullets = reply
    .replace(/```[a-z]*/gi, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^[-*•]\s/.test(l) && names.some(n => new RegExp(`\\b${n}\\b`).test(l)))
    .map(l => `- ${l.replace(/^[-*•]\s+/, '').replace(/`/g, '')}`);
  const text = bullets.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[contract truncated]` : text;
}

export interface WrittenContract { text: string; dropped: string[] }

export async function writeContract(
  input: CodingAgentsInput, root: string, target: string, names: string[], chat?: ChatFn, sites?: Map<string, CallSite[]>,
): Promise<WrittenContract> {
  const empty: WrittenContract = { text: '', dropped: [] };
  const requested = input.contractModel;
  if (!requested || !input.verifyCommand || names.length === 0) return empty;
  const local = await import('../../providers/ollama-local.js');
  const installed = await local.listLocalModels().catch(() => [] as string[]);
  const model = installed.find(m => m === requested || m.startsWith(`${requested}:`));
  if (!model) return empty;
  const testSpec = await readVerifyTestContext(input.verifyCommand, root);
  if (!testSpec) return empty;
  const shapes = input.contextDirs?.length ? buildExternalContext({ dirs: input.contextDirs, maxChars: 2500 }) : '';
  const call: ChatFn = chat ?? ((m, messages, options) => local.chatLocal(m, messages, options));
  try {
    const res = await call(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: contractPrompt({ target, names, testSpec, shapes }) },
    ], { temperature: 0, maxTokens: 900, think: false });
    const cleaned = cleanContract(res.content, names);
    if (!sites || sites.size === 0) return { text: cleaned, dropped: [] };
    const { kept, dropped } = validateContractBullets(cleaned.split('\n').filter(Boolean), sites);
    return { text: kept.join('\n'), dropped };
  } catch {
    return empty;
  }
}
