/**
 * A goal that supplies the exact replacement text is a work order. When an edit lacks that text, the repair loop
 * says so in the next brief (missingLiterals, workOrderNote) and asks a local model what to do next (triageDeviation).
 */

export type TriageCause = 'not_copied' | 'wrong_place' | 'goal_unclear';
export type TriageAction = 'retry' | 'reroute' | 'stop';
export interface TriageResult { cause: TriageCause; action: TriageAction; source: 'local' | 'rule' }

const DEFAULT_ACTION: Record<TriageCause, TriageAction> = { not_copied: 'reroute', wrong_place: 'retry', goal_unclear: 'stop' };
const RULE_RESULT: TriageResult = { cause: 'not_copied', action: 'reroute', source: 'rule' };

/** The backticked code the goal says to put in place: spans of 8+ characters after the first "replace ... with", none if that is negated. */
export function requiredLiterals(goal: string): string[] {
  const match = goal.match(/\breplace\b[\s\S]*?\bwith\b/i);
  if (!match) return [];

  const preMatchText = goal.slice(0, match.index ?? 0).toLowerCase();
  if (preMatchText.includes('do not') || preMatchText.includes("don't")) return [];

  const postMatchText = goal.slice((match.index ?? 0) + match[0].length);
  const literals = postMatchText.match(/`([^`]+)`/g);
  if (!literals) return [];

  return literals.map(literal => literal.slice(1, -1).trim()).filter(literal => literal.length >= 8);
}

/** The required literals that no file content includes. */
export function missingLiterals(goal: string, contents: string[]): string[] {
  return requiredLiterals(goal).filter(literal => !contents.some(content => content.includes(literal)));
}

/** The line that opens the next brief. */
export function workOrderNote(missing: string[]): string {
  return ['The goal supplied this exact text; copy it character for character:', ...missing].join('\n');
}

/** Asks a local Ollama model for a JSON reply. Throws on an HTTP error. */
export async function localTriageAsk(prompt: string): Promise<string> {
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.CODING_AGENTS_TRIAGE_MODEL || 'qwen2.5-coder:7b', prompt, format: 'json', stream: false }) });
  if (!res.ok) throw new Error(`triage model returned ${res.status}`);
  return String((await res.json()).response ?? '');
}

/** Parses a triage reply; anything that is not a valid cause gives the rule result. */
export function parseTriage(reply: string): TriageResult {
  try {
    const parsed = JSON.parse(reply);
    if (typeof parsed !== 'object' || parsed === null) return RULE_RESULT;
    const cause = parsed.cause as TriageCause;
    if (!DEFAULT_ACTION.hasOwnProperty(cause)) return RULE_RESULT;
    const action = parsed.action;
    if (action !== 'retry' && action !== 'reroute' && action !== 'stop') return { cause, action: DEFAULT_ACTION[cause], source: 'local' };
    return { cause, action, source: 'local' };
  } catch {
    return RULE_RESULT;
  }
}

/** Asks why the edit lacks the text, within a time limit; any failure gives the rule result. */
export async function triageDeviation(
  facts: { goal: string; missing: string[]; brief: string },
  ask: (prompt: string) => Promise<string> = localTriageAsk,
  timeoutMs = 20000,
): Promise<TriageResult> {
  const prompt = ['A coding model was given a goal that supplied exact code, and its edit does not contain that code.', 'Goal: ' + facts.goal, 'Missing text: ' + facts.missing.join(' | '), 'Check output: ' + facts.brief.slice(0, 600), 'Reply with JSON only: {"cause": "not_copied" | "wrong_place" | "goal_unclear", "action": "retry" | "reroute" | "stop"}'].join('\n');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('triage timed out')), timeoutMs); });
  try {
    return parseTriage(await Promise.race([ask(prompt), timeout]));
  } catch {
    return RULE_RESULT;
  } finally {
    clearTimeout(timer);
  }
}
