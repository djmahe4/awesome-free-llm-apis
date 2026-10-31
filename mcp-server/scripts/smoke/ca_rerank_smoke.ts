/**
 * Smoke challenge: the distractor. 30 files under src/ share the goal's everyday words (apply, discount, total, order);
 * the one file the goal is about sits in src/zz_billing/ (it sorts after all of them) and is the only one that contains its distinctive name.
 * Before reranking, ties fall back to alphabetical order and the 5-file cap cuts the relevant file off.
 *
 *   D1  relevant file is among the files returned (limit 5)
 *   D2  it is returned first
 *   D3  a second goal naming a file explicitly still puts that file first
 *   D4  CONTEXT_RERANK=off restores the old order (rollback switch)
 *
 *   npx tsx scripts/smoke/ca_rerank_smoke.ts
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { ContextGatherer, __test_clearCache } = await import('../../src/pipeline/middlewares/context-gatherer.js');

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-rerank-'));
await fs.mkdir(path.join(ws, 'src'), { recursive: true });
await fs.mkdir(path.join(ws, 'src/zz_billing'), { recursive: true });
for (let i = 0; i < 30; i++) {
  const n = String(i).padStart(2, '0');
  await fs.writeFile(path.join(ws, `src/mod_${n}.ts`), [
    `// order total helper ${n}`,
    `export function applyTotal${n}(order: number, discount: number) { return order - discount; }`,
    `export function discountOrder${n}(total: number) { return apply(total) + discount(total); }`,
  ].join('\n') + '\n');
}
await fs.writeFile(path.join(ws, 'src/zz_billing/loyalty.ts'), [
  'export function applyLoyaltyDiscount(order: number, tier: number) {',
  '  return Math.round(order * (1 - tier / 100));',
  '}',
].join('\n') + '\n');

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };
const files = (out: string[]) => out.flatMap(r => [...r.matchAll(/--- (?:RELATED )?FILE: (.+?)(?: \(via dep-graph\))? ---/g)].map(m => m[1].replace(/\\/g, '/')));
const run = async (query: string) => { __test_clearCache(); return files(await ContextGatherer.gatherContext({ workspaceRoot: ws, query, limit: 5 })); };

try {
  const q = 'fix applyLoyaltyDiscount so the order total rounds the discount correctly';
  let got = await run(q);
  check('D1 relevant file is returned', got.some(f => f.endsWith('src/zz_billing/loyalty.ts')), JSON.stringify(got));
  check('D2 relevant file is first', got[0]?.endsWith('src/zz_billing/loyalty.ts') === true, JSON.stringify(got));

  got = await run('apply the discount in src/mod_07.ts to the order total');
  check('D3 an explicitly named file still comes first', got[0]?.endsWith('src/mod_07.ts') === true, JSON.stringify(got));

  process.env.CONTEXT_RERANK = 'off';
  got = await run(q);
  check('D4 rerank off restores the old order', !got.some(f => f.endsWith('src/zz_billing/loyalty.ts')) || got[0]?.endsWith('loyalty.ts') === false, JSON.stringify(got));
  delete process.env.CONTEXT_RERANK;
} finally {
  await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const failed = results.filter(r => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
