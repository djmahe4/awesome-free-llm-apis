/**
 * Curated behaviour of platform APIs that a test only reveals as a failure and that a small model reliably gets wrong.
 * These are reference facts, not claims about the workspace: they are shown to the editor only when the goal or the
 * tests mention the API, and each is a single verifiable sentence.
 *
 * Admission rule: an entry needs an observed failure that it fixes, and the ladder (scripts/smoke/ladder_coding_agents.ts)
 * must not get worse with it. A "sort mutates in place" entry looked harmless, but with it a 7B model's rung-4 edit failed
 * 6 of 6 runs (correct code, unusable SEARCH block) and passed 2 of 2 without it, so it was removed.
 */
interface ApiFact { id: string; trigger: RegExp; fact: string }

const FACTS: ApiFact[] = [
  {
    id: 'node-sqlite-open',
    trigger: /node:sqlite|\bDatabaseSync\b/,
    fact: 'node:sqlite: `new DatabaseSync(path)` CREATES the file when it is missing and does not throw. To open only an existing database use `new DatabaseSync(path, { readOnly: true })` (it throws for a missing file) or check `fs.existsSync(path)` first, and return null from the catch.',
  },
];

/** Facts whose trigger appears in `text`, as one block (empty when none), capped at `maxChars`. */
export function apiFactsFor(text: string, maxChars = 900): string {
  const hits = FACTS.filter(f => f.trigger.test(text)).map(f => `- ${f.fact}`);
  if (hits.length === 0) return '';
  const block = `[API facts: reference behaviour, not workspace claims]\n${hits.join('\n')}`;
  return block.length > maxChars ? `${block.slice(0, maxChars)}\n[truncated]` : block;
}
