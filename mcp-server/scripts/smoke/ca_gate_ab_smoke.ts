/**
 * Gate off versus gate on over a fixed set of goals: 8 with a planted wrong assumption and 8 that are fine.
 * Prints METRIC lines that ca_eval.ts records and holds to the baseline:
 *
 *   catch_rate_off / catch_rate_on     share of planted goals stopped before any edit
 *   false_block_rate_off / _on         share of fine goals that were stopped by mistake
 *   gate_ms_per_goal                   what the check costs (reported, not gated)
 *
 *   npx tsx scripts/smoke/ca_gate_ab_smoke.ts
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { runHypothesisGate } = await import('../../src/tools/coding-agents/hypothesis-gate.js');

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-ab-'));
await fs.mkdir(path.join(ws, 'src'), { recursive: true });
await fs.writeFile(path.join(ws, 'src/currency.ts'), [
  'export function convertCurrency(amount: number, rate: number): number { return amount * rate; }',
  'export function getUser(id: string) { return { id }; }',
  'export class Cart { add(item: string, qty: number) { return qty; } }',
].join('\n') + '\n');
await fs.writeFile(path.join(ws, 'src/pricing.py'), 'def apply_discount(price, pct):\n    return price\n');
const FILES = ['src/currency.ts', 'src/pricing.py'];

interface Case { goal: string; targetFiles?: string[] }
const planted: Case[] = [
  { goal: 'make `fetchUser` cache its result' },
  { goal: 'fix convertMoney() for negative amounts' },
  { goal: 'tidy src/currency.ts', targetFiles: ['src/utils/helpers.ts'] },
  { goal: 'rename `Basket` and update callers' },
  { goal: 'speed up `applyDiscountCode`' },
  { goal: 'add a test for `getAccount`' },
  { goal: 'refactor src/billing/invoice.ts', targetFiles: ['src/billing/invoice.ts'] },
  { goal: 'handle errors in `loadRates()`' },
];
const fine: Case[] = [
  { goal: 'make `getUser` cache its result' },
  { goal: 'fix convertCurrency() for negative amounts' },
  { goal: 'tidy src/currency.ts', targetFiles: ['src/currency.ts'] },
  { goal: 'add a function `formatMoney` to src/currency.ts' },
  { goal: 'create a new class `Wallet`' },
  { goal: 'speed up `apply_discount`' },
  { goal: 'document `Cart`' },
  { goal: 'implement `parseRow` in src/pricing.py' },
];

async function blockedShare(cases: Case[], mode: 'off' | 'enforce'): Promise<{ share: number; ms: number }> {
  let blocked = 0;
  const started = Date.now();
  for (const c of cases) {
    const g = await runHypothesisGate({ mode, goal: c.goal, files: FILES, targetFiles: c.targetFiles, workspaceRoot: ws });
    if (g.blocked) blocked++;
  }
  return { share: blocked / cases.length, ms: (Date.now() - started) / cases.length };
}

try {
  const catchOff = await blockedShare(planted, 'off');
  const catchOn = await blockedShare(planted, 'enforce');
  const falseOff = await blockedShare(fine, 'off');
  const falseOn = await blockedShare(fine, 'enforce');
  const metrics: Record<string, number> = {
    catch_rate_off: catchOff.share, catch_rate_on: catchOn.share,
    false_block_rate_off: falseOff.share, false_block_rate_on: falseOn.share,
    gate_ms_per_goal: Math.round(((catchOn.ms + falseOn.ms) / 2) * 10) / 10,
  };
  for (const [k, v] of Object.entries(metrics)) console.log(`METRIC ${k}=${v}`);
  console.log(catchOn.share === 1 ? 'ok   gate on stops every planted goal' : 'FAIL gate on missed a planted goal');
  console.log(falseOn.share === 0 ? 'ok   gate on stops no fine goal' : 'FAIL gate on stopped a fine goal');
  console.log(catchOff.share === 0 ? 'ok   gate off stops nothing' : 'FAIL gate off stopped a goal');
  const good = catchOn.share === 1 && falseOn.share === 0 && catchOff.share === 0;
  console.log(good ? 'PASS: the gate stops every planted goal and no fine one; with it off nothing is stopped' : 'FAIL: gate behaviour changed');
  process.exitCode = good ? 0 : 1;
} finally {
  await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
