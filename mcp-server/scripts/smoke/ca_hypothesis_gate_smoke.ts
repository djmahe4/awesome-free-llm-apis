/**
 * Smoke challenge: coding challenges whose goals rest on a wrong assumption, run through the real
 * CodingAgentsHandler (dryRun, so no model and no edits are needed; the gate decides before any model call).
 *
 * Sample project: a small currency module. Each challenge is a goal a careless planner would accept:
 *   A  names a function that does not exist (fetchUser; the code has getUser)     enforce -> blocked, hypotheses.md says why
 *   B  names a function that exists (getUser)                                      enforce -> proceeds
 *   C  targets a file that was invented (src/utils/helpers.ts)                      enforce -> blocked
 *   D  same wrong goal as A with the gate on 'warn'                                warn    -> proceeds, with a warning
 *   E  asks to ADD a new function (formatMoney): not existing is the point         enforce -> proceeds
 *   F  same wrong goal as A with the gate 'off'                                    off     -> proceeds, nothing written
 *
 *   npx tsx scripts/smoke/ca_hypothesis_gate_smoke.ts
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { CodingAgentsHandler } = await import('../../src/tools/coding-agents.js');

async function workspace(gate: 'off' | 'warn' | 'enforce') {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-gate-ws-'));
  await fs.mkdir(path.join(ws, 'src'), { recursive: true });
  await fs.mkdir(path.join(ws, '.free-llm-mcp'), { recursive: true });
  await fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisGate: gate }));
  await fs.writeFile(path.join(ws, 'src/currency.ts'), [
    'export function convertCurrency(amount: number, rate: number): number { return amount * rate; }',
    'export function getUser(id: string) { return { id }; }',
  ].join('\n') + '\n');
  return ws;
}

interface Challenge { name: string; gate: 'off' | 'warn' | 'enforce'; goal: string; targetFiles?: string[]; expect: 'blocked' | 'proceeds'; warns?: boolean; hypothesesFile?: boolean }
const challenges: Challenge[] = [
  { name: 'A wrong symbol, enforce', gate: 'enforce', goal: 'make `fetchUser` cache its result in src/currency.ts', targetFiles: ['src/currency.ts'], expect: 'blocked', hypothesesFile: true },
  { name: 'B real symbol, enforce', gate: 'enforce', goal: 'make `getUser` return a frozen object in src/currency.ts', targetFiles: ['src/currency.ts'], expect: 'proceeds' },
  { name: 'C invented file, enforce', gate: 'enforce', goal: 'tidy the exports', targetFiles: ['src/utils/helpers.ts'], expect: 'blocked', hypothesesFile: true },
  { name: 'D wrong symbol, warn', gate: 'warn', goal: 'make `fetchUser` cache its result in src/currency.ts', targetFiles: ['src/currency.ts'], expect: 'proceeds', warns: true },
  { name: 'E new function, enforce', gate: 'enforce', goal: 'add a function `formatMoney` to src/currency.ts', targetFiles: ['src/currency.ts'], expect: 'proceeds' },
  { name: 'F wrong symbol, off', gate: 'off', goal: 'make `fetchUser` cache its result in src/currency.ts', targetFiles: ['src/currency.ts'], expect: 'proceeds' },
];

let failures = 0;
for (const c of challenges) {
  const ws = await workspace(c.gate);
  const before = await fs.readFile(path.join(ws, 'src/currency.ts'), 'utf-8');
  const r: any = await CodingAgentsHandler({ goal: c.goal, workspaceRoot: ws, targetFiles: c.targetFiles, dryRun: true, topKFiles: 1, sessionId: `gate-smoke-${Date.now()}-${c.name[0]}`, review: false } as any);
  const blocked = r.status === 'paused' && /assumption/i.test(r.patchSummary ?? '');
  const hyp = await fs.readFile(path.join(ws, 'hypotheses.md'), 'utf-8').catch(() => null);
  const warned = (r.diagnostics ?? []).some((d: any) => d.severity === 'warning' && /assumption|hypothes/i.test(d.message));
  const unchanged = (await fs.readFile(path.join(ws, 'src/currency.ts'), 'utf-8')) === before;
  const problems: string[] = [];
  if ((c.expect === 'blocked') !== blocked) problems.push(`expected ${c.expect}, got status=${r.status}`);
  if (c.hypothesesFile && !(hyp && /refuted/.test(hyp))) problems.push('hypotheses.md missing or has no refuted row');
  if (c.gate === 'off' && hyp) problems.push('gate off but hypotheses.md was written');
  if (c.warns && !warned) problems.push('no warning diagnostic');
  if (!unchanged) problems.push('source file changed');
  if (problems.length) failures++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name}${problems.length ? ' :: ' + problems.join('; ') : ''}`);
  if (hyp && process.env.SHOW) console.log(hyp);
  await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(failures === 0 ? 'PASS: wrong assumptions stopped before any edit; right ones and new code were not blocked' : `FAIL: ${failures} challenge(s)`);
process.exit(failures === 0 ? 0 : 1);
