/**
 * Smoke challenge: wiki claims and hypotheses.md must survive people editing them, and must not trust those edits.
 *
 * Real components only: runHypothesisGate + writeHypothesesFile on a real workspace, and a real WikiMemory with
 * source checking turned on. Each challenge is something a person plausibly does:
 *
 *   H1  adds their own row (id u1) and a note under the table      -> both survive the next run, row re-checked
 *   H2  hand-edits a false row to "confirmed"                       -> the probe decides, it is refuted again
 *   H3  writes a row with a probe nobody recognises, status confirmed -> stays open, never confirmed, never blocks
 *   H4  adds a row that is false, gate enforce                       -> blocks like any other assumption
 *   H5  leaves rows from an old goal in the file                     -> dropped, not carried forever
 *   H6  mangles the table (CRLF, short rows, stray text)             -> no throw
 *   W1  wiki page whose claims hold, rewritten twice                 -> confidence rises, ADR on a decision
 *   W2  page whose source file changed so a claim is now false       -> confidence does not rise, no ADR, marked unverified
 *   W3  person hand-edits the page to say the false claim is confirmed -> recomputed, still unverified
 *   W4  page with no claims at all, source checking on               -> readable, capped below the ADR threshold
 *   W5  person writes an ADR directly                                -> unaffected
 *
 *   npx tsx scripts/smoke/wiki_claims_human_smoke.ts
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.WIKI_CLAIM_VERIFICATION = 'enforce';
const { runHypothesisGate, writeHypothesesFile, HYPOTHESES_FILE } = await import('../../src/tools/coding-agents/hypothesis-gate.js');
const { WikiMemory } = await import('../../src/memory/wiki.js');

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-claims-ws-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-claims-home-'));
await fs.mkdir(path.join(ws, 'src'), { recursive: true });
await fs.writeFile(path.join(ws, 'src/currency.ts'), 'export function convertCurrency(amount: number, rate: number): number { return amount * rate; }\nexport function getUser(id: string) { return { id }; }\n');
const FILES = ['src/currency.ts'];
const mdPath = path.join(ws, HYPOTHESES_FILE);
const gate = (mode: 'warn' | 'enforce', goal = 'tidy `getUser`') => runHypothesisGate({ mode, goal, files: FILES, workspaceRoot: ws });
const save = async (goal: string, g: Awaited<ReturnType<typeof gate>>) => writeHypothesesFile(ws, goal, g.hypotheses);

try {
  // ---- hypotheses.md edited by a person ---------------------------------------------------------------------------
  let g = await gate('warn'); await save('tidy `getUser`', g);
  let md = await fs.readFile(mdPath, 'utf-8');
  md += '\n| u1 | convertCurrency takes two arguments | `arity:convertCurrency@src/currency.ts=2` | open | |\n\nNote from Maya: check the rounding too.\n';
  await fs.writeFile(mdPath, md);
  g = await gate('warn'); await save('tidy `getUser`', g);
  md = await fs.readFile(mdPath, 'utf-8');
  check('H1 human row kept and re-checked', g.hypotheses.some(h => h.id === 'u1' && h.status === 'confirmed'), JSON.stringify(g.hypotheses));
  check('H1 human note kept', md.includes('Note from Maya: check the rounding too.'), md);

  await fs.writeFile(mdPath, md.replace('| u1 |', '| u2 | getUser takes 3 arguments | `arity:getUser@src/currency.ts=3` | confirmed | I checked by hand |\n| u1 |'));
  g = await gate('warn');
  const u2 = g.hypotheses.find(h => h.id === 'u2');
  check('H2 hand-set "confirmed" does not stand', u2?.status === 'refuted', JSON.stringify(u2));

  await fs.writeFile(mdPath, md + '| u3 | it will just work | `vibes:ok` | confirmed | trust me |\n');
  g = await gate('enforce');
  const u3 = g.hypotheses.find(h => h.id === 'u3');
  check('H3 unrecognised probe stays open', u3?.status === 'open' && /probe/i.test(u3.evidence ?? ''), JSON.stringify(u3));
  check('H3 unrecognised probe does not block', g.blocked === false, g.summary);

  await fs.writeFile(mdPath, md + '| u4 | normalizeCurrency exists | `defined:normalizeCurrency` | open | |\n');
  g = await gate('enforce');
  check('H4 false human row blocks under enforce', g.blocked === true && /normalizeCurrency/.test(g.summary), g.summary);

  await fs.writeFile(mdPath, '# Hypotheses: older goal\n\n| id | claim | probe | status | evidence |\n|----|-------|-------|--------|----------|\n| h1 | old claim | `file:src/gone.ts` | refuted | missing |\n');
  g = await gate('enforce'); await save('tidy `getUser`', g);
  md = await fs.readFile(mdPath, 'utf-8');
  check('H5 rows from an old goal are dropped', !md.includes('src/gone.ts') && g.blocked === false, md);

  await fs.writeFile(mdPath, '# Hyp\r\n| id | claim |\r\n| h1 |\r\nrandom text | with | pipes\r\n| u9 | x | `file:src/currency.ts` | open | |\r\n');
  let threw = false; try { g = await gate('warn'); await save('tidy `getUser`', g); } catch { threw = true; }
  check('H6 mangled file does not throw', !threw);

  // ---- wiki pages ----------------------------------------------------------------------------------------------------
  const claims = (rows: string[]) => ['', '## Claims', '', '| id | claim | probe | status | evidence |', '|----|-------|-------|--------|----------|', ...rows, ''].join('\n');
  const decision = 'We decided to keep currency conversion in one module because rates change together.';
  const wiki = new WikiMemory('claims-smoke', path.join(home, 'wiki'), ws);

  const body = decision + claims(['| c1 | convertCurrency is defined | `defined:convertCurrency` | open | |']);
  const p1 = await wiki.write('Currency design', body);
  const p2 = await wiki.write('Currency design', body);
  const p3 = await wiki.write('Currency design', body);
  const p4 = await wiki.write('Currency design', body);
  check('W1 confirmed claims let confidence rise and an ADR appear', p4.confidence > p1.confidence && !!p4.adr_ref, `${p1.confidence}->${p4.confidence} adr=${p4.adr_ref}`);

  const bad = decision + claims(['| c1 | getUser takes 3 arguments | `arity:getUser@src/currency.ts=3` | confirmed | I did check |']);
  let q: any;
  for (let i = 0; i < 5; i++) q = await wiki.write('Users design', bad);
  check('W2/W3 a false claim blocks the rise and the ADR, whatever the page says', q.confidence <= 0.5 && !q.adr_ref, `confidence=${q.confidence} adr=${q.adr_ref}`);
  const read = await wiki.read('Users design');
  check('W2 page is marked unverified', !!read && (read.tags.includes('unverified') || /unverified/i.test(read.content)), JSON.stringify(read?.tags));

  let r: any;
  for (let i = 0; i < 6; i++) r = await wiki.write('Plain notes', decision);
  check('W4 page with no claims is readable and held under the ADR threshold', r.confidence < 0.85 && !r.adr_ref, `confidence=${r.confidence} adr=${r.adr_ref}`);

  const adrId = await (wiki as any).createADR('Hand written decision', 'Decided by the team in a meeting.');
  check('W5 explicit ADR is unaffected', /^ADR-\d+/.test(adrId), String(adrId));
} finally {
  await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const failed = results.filter(r => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
