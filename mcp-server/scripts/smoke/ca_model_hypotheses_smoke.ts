/**
 * Smoke challenge: the parts that sit on top of the mechanical gate. A mocked model proposes extra assumptions and
 * corrects a refuted goal; command probes check claims about running code. Real gate, real files, real child processes.
 *
 *   X1  cmd: probe with command probes switched off          -> open, command not run
 *   X2  same probe with them switched on                      -> confirmed, command ran
 *   X3  cmd:1@... claims a failing exit code                  -> confirmed; cmd:0@ on the same command -> refuted
 *   X4  test: probe                                           -> confirmed when it passes, refuted with the output when not
 *   X5  a command outside the allowlist / with shell syntax   -> never run
 *   X6  a wiki claim carrying a cmd: probe                    -> never run, even with command probes on
 *   M1  model proposals: true one confirmed, false one refuted, vacuous / command / garbled rejected, its own status ignored
 *   M2  proposer throws                                       -> the derived checks still run
 *   M3  total hypotheses stay capped
 *   R1  refuted goal, reviser fixes it                        -> run is not blocked, one re-plan recorded
 *   R2  reviser returns the same wrong goal                   -> blocked, reviser called once (no loop)
 *   R3  reviser throws                                        -> blocked as before
 *   R4  warn mode                                             -> reviser not called
 *
 *   npx tsx scripts/smoke/ca_model_hypotheses_smoke.ts
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { runHypothesisGate } = await import('../../src/tools/coding-agents/hypothesis-gate.js');
const { runProbe } = await import('../../src/tools/coding-agents/hypotheses.js');
const { checkPageClaims } = await import('../../src/memory/wiki-claims.js');

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };

const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-model-hyp-'));
await fs.mkdir(path.join(ws, 'src'), { recursive: true });
await fs.mkdir(path.join(ws, '.free-llm-mcp'), { recursive: true });
await fs.writeFile(path.join(ws, 'src/a.ts'), 'export function getUser(id: string) { return id; }\n');
await fs.writeFile(path.join(ws, 'ok.js'), "require('fs').writeFileSync('ran.marker', 'x'); console.log('all good');\n");
await fs.writeFile(path.join(ws, 'fail.js'), "console.log('boom: expected 2 got 3'); process.exit(1);\n");
const FILES = ['src/a.ts'];
const setExec = (on: boolean) => fs.writeFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({ hypothesisExec: on }));
const marker = () => fs.access(path.join(ws, 'ran.marker')).then(() => true, () => false);
const clearMarker = () => fs.rm(path.join(ws, 'ran.marker'), { force: true });

try {
  // ---- command probes ------------------------------------------------------------------------------------------------
  await setExec(false); await clearMarker();
  let r = await runProbe('cmd:0@node ok.js', ws);
  check('X1 off: open and not run', r.status === 'open' && !(await marker()), JSON.stringify(r));

  await setExec(true);
  r = await runProbe('cmd:0@node ok.js', ws, { allowExec: true });
  check('X2 on: confirmed and ran', r.status === 'confirmed' && (await marker()), JSON.stringify(r));

  r = await runProbe('cmd:1@node fail.js', ws, { allowExec: true });
  const r0 = await runProbe('cmd:0@node fail.js', ws, { allowExec: true });
  check('X3 exit code as claimed', r.status === 'confirmed' && r0.status === 'refuted' && /exit(ed)? (code )?1/i.test(r0.evidence), JSON.stringify([r, r0]));

  const t1 = await runProbe('test:node ok.js', ws, { allowExec: true });
  const t2 = await runProbe('test:node fail.js', ws, { allowExec: true });
  check('X4 test: confirmed when passing, refuted with output when failing', t1.status === 'confirmed' && t2.status === 'refuted' && /boom/.test(t2.evidence), JSON.stringify([t1, t2]));

  await clearMarker();
  const bad = [await runProbe('cmd:0@rm -rf .', ws, { allowExec: true }), await runProbe('cmd:0@node ok.js && echo hi', ws, { allowExec: true }), await runProbe('test:curl http://x', ws, { allowExec: true })];
  check('X5 disallowed commands are never run', bad.every(b => b.status !== 'confirmed') && !(await marker()), JSON.stringify(bad));

  const page = await checkPageClaims('| id | claim | probe | status | evidence |\n|--|--|--|--|--|\n| c1 | runs | `cmd:0@node ok.js` | confirmed | trust me |\n', ws);
  check('X6 wiki claims never execute', !(await marker()) && page.claims[0].status === 'open', JSON.stringify(page.claims));

  // ---- model proposals --------------------------------------------------------------------------------------------------
  const base = { mode: 'warn' as const, goal: 'tidy `getUser`', files: FILES, workspaceRoot: ws };
  let g = await runHypothesisGate({
    ...base,
    propose: async () => [
      { claim: 'getUser is exported from src/a.ts', probe: 'symbol:getUser@src/a.ts', status: 'confirmed' },
      { claim: 'fetchUser exists', probe: 'defined:fetchUser', status: 'confirmed' },
      { claim: 'something matches', probe: 'grep:.*@src/a.ts' },
      { claim: 'it runs', probe: 'cmd:0@node ok.js' },
      { claim: 'garbled', probe: 'what even is this' },
    ],
  });
  const byProbe = (p: string) => g.hypotheses.find(h => h.probe === p);
  check('M1 true proposal confirmed', byProbe('symbol:getUser@src/a.ts')?.status === 'confirmed');
  check('M1 false proposal refuted despite the model saying confirmed', byProbe('defined:fetchUser')?.status === 'refuted');
  check('M1 vacuous, command and garbled proposals rejected', !byProbe('grep:.*@src/a.ts') && !byProbe('cmd:0@node ok.js') && !byProbe('what even is this') && g.rejected.length === 3, JSON.stringify(g.rejected));

  g = await runHypothesisGate({ ...base, propose: async () => { throw new Error('model down'); } });
  check('M2 proposer failure leaves the derived checks', g.hypotheses.some(h => h.probe === 'defined:getUser'));

  g = await runHypothesisGate({ ...base, propose: async () => Array.from({ length: 40 }, (_, i) => ({ claim: `c${i}`, probe: `defined:name${i}x` })) });
  check('M3 total is capped', g.hypotheses.length <= 12, String(g.hypotheses.length));

  // ---- one re-plan ------------------------------------------------------------------------------------------------------
  const wrong = 'make `fetchUser` cache its result';
  let calls = 0;
  g = await runHypothesisGate({ ...base, mode: 'enforce', goal: wrong, revise: async () => { calls++; return 'make `getUser` cache its result'; } });
  check('R1 corrected goal is not blocked, one re-plan recorded', !g.blocked && g.replanned === true && calls === 1 && g.goal.includes('getUser'), JSON.stringify({ blocked: g.blocked, replanned: g.replanned, goal: g.goal }));

  calls = 0;
  g = await runHypothesisGate({ ...base, mode: 'enforce', goal: wrong, revise: async () => { calls++; return wrong; } });
  check('R2 same wrong goal stays blocked, reviser called once', g.blocked && calls === 1, `blocked=${g.blocked} calls=${calls}`);

  g = await runHypothesisGate({ ...base, mode: 'enforce', goal: wrong, revise: async () => { throw new Error('model down'); } });
  check('R3 reviser failure leaves the block', g.blocked === true);

  calls = 0;
  g = await runHypothesisGate({ ...base, mode: 'warn', goal: wrong, revise: async () => { calls++; return 'x'; } });
  check('R4 warn mode does not spend a model call', calls === 0 && !g.blocked);
} finally {
  await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const failed = results.filter(r => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
