/**
 * Smoke challenge: dashboard inputs per action, as hypotheses about OUR OWN handlers.
 * Every claim in scripts/verification/showfor-claims.ts ("movie_tool/add_artifact needs track") is a hypothesis with a
 * grep probe against the real handler source. Pass = every claim is confirmed; a refuted one means the claim (or the
 * handler) is wrong and no showFor entry may rely on it.
 *
 *   npx tsx scripts/smoke/dashboard_showfor_hypotheses_smoke.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELD_USES } from '../verification/showfor-claims.js';
import { validateHypotheses } from '../../src/tools/coding-agents/hypotheses.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const list = FIELD_USES.map((u, i) => ({ id: `h${i + 1}`, claim: `${u.tool}: ${u.actions.map(a => a || '(default)').join('/')} ${u.need === 'required' ? 'needs' : 'reads'} ${u.field}`, probe: u.probe, status: 'open' as const }));
const out = await validateHypotheses(list, root);
let refuted = 0;
for (const h of out) {
  if (h.status === 'refuted') { refuted++; console.log(`REFUTED ${h.claim}\n        ${h.evidence}`); }
}
console.log(`${out.length - refuted}/${out.length} claims confirmed against the handler source`);
console.log(refuted === 0 ? 'PASS: every per-action input claim is backed by the code' : `FAIL: ${refuted} claim(s) refuted`);
process.exit(refuted === 0 ? 0 : 1);
