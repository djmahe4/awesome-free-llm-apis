/**
 * Smoke challenge: a plan built on wrong assumptions.
 * A sample project (a currency converter in TypeScript, a pricing module in Python) and a "plan" whose hypotheses
 * mix true claims with the three mistakes a model typically makes: a symbol that does not exist (fetchUser instead
 * of getUser), a file it invented, and a wrong argument count. Pass = every claim gets the status below, and each
 * verdict carries evidence the probe computed (no model involved).
 *
 *   npx tsx scripts/smoke/ca_hypothesis_probes_smoke.ts
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-hyp-ws-'));
await fs.mkdir(path.join(ws, 'src'), { recursive: true });
await fs.writeFile(path.join(ws, 'src/currency.ts'), [
  'export function convertCurrency(amount: number, rate: number, rounding = 2): number {',
  '  return Number((amount * rate).toFixed(rounding));',
  '}',
  'export function getUser(id: string) { return { id }; }',
  'export const DEFAULT_RATE = 1.1;',
  'export const fmt = (n: number) => n.toFixed(4);',
].join('\n') + '\n');
await fs.writeFile(path.join(ws, 'src/pricing.py'), [
  'def apply_discount(price, percent):',
  '    return price * (1 - percent / 100)',
  '',
  'class Cart:',
  '    def add(self, item, qty=1):',
  '        pass',
].join('\n') + '\n');

const { validateHypotheses } = await import('../../src/tools/coding-agents/hypotheses.js');

const plan = [
  { id: 'h1', claim: 'currency.ts exists', probe: 'file:src/currency.ts', expect: 'confirmed' },
  { id: 'h2', claim: 'convertCurrency is defined in currency.ts', probe: 'symbol:convertCurrency@src/currency.ts', expect: 'confirmed' },
  { id: 'h3', claim: 'fetchUser is defined in currency.ts', probe: 'symbol:fetchUser@src/currency.ts', expect: 'refuted' },
  { id: 'h4', claim: 'a helpers module exists', probe: 'file:src/utils/helpers.ts', expect: 'refuted' },
  { id: 'h5', claim: 'convertCurrency takes two arguments', probe: 'arity:convertCurrency@src/currency.ts=2', expect: 'refuted' },
  { id: 'h6', claim: 'convertCurrency takes three arguments', probe: 'arity:convertCurrency@src/currency.ts=3', expect: 'confirmed' },
  { id: 'h7', claim: 'apply_discount takes two arguments (python)', probe: 'arity:apply_discount@src/pricing.py=2', expect: 'confirmed' },
  { id: 'h8', claim: 'Cart.add takes item and qty (self is not counted)', probe: 'arity:add@src/pricing.py=2', expect: 'confirmed' },
  { id: 'h9', claim: 'DEFAULT_RATE is 1.1', probe: String.raw`grep:DEFAULT_RATE = 1\.1@src/currency.ts`, expect: 'confirmed' },
  { id: 'h10', claim: 'the code formats with toFixed(4)', probe: String.raw`grep:toFixed\(4\)@src/currency.ts`, expect: 'confirmed' },
  { id: 'h12', claim: 'the code formats with toFixed(6)', probe: String.raw`grep:toFixed\(6\)@src/currency.ts`, expect: 'refuted' },
  { id: 'h11', claim: 'a path outside the workspace is not readable', probe: 'file:../../etc/passwd', expect: 'refuted' },
];

const results = await validateHypotheses(plan.map(({ id, claim, probe }) => ({ id, claim, probe, status: 'open' as const })), ws);
let failures = 0;
for (const p of plan) {
  const r = results.find(x => x.id === p.id)!;
  const ok = r.status === p.expect && !!r.evidence;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.id} ${p.claim} -> ${r.status}${r.evidence ? ` (${r.evidence})` : ' (NO EVIDENCE)'}`);
}
console.log(failures === 0 ? 'PASS: every wrong assumption was refuted with evidence, every true one confirmed' : `FAIL: ${failures} verdict(s) wrong`);
await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.exit(failures === 0 ? 0 : 1);
