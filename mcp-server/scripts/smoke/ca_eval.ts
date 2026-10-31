/**
 * Continuous evaluation of the grounding mechanisms (slice 7 of docs/plans/2026-10-30-grounded-coding-agents.md).
 *
 * Each fixture is a smoke script that plants a hallucination and checks that it is caught, with real components and no
 * model call (the gate decides before any model is reached), so it runs the same in CI as locally:
 *
 *   wrong-symbol, invented-file, arity   ca_hypothesis_gate_smoke, ca_hypothesis_probes_smoke
 *   stale-cache                          ca_stale_evidence_smoke
 *   stale-wiki, human edits              wiki_claims_human_smoke
 *   distractor                           ca_rerank_smoke
 *   dashboard sync (first case)          dashboard_showfor_hypotheses_smoke
 *
 * The runner records per-fixture result, number of passing checks and time in scripts/smoke/results/latest.json and
 * compares it with the committed baseline.json. It fails when a fixture fails, disappears, or runs fewer passing checks
 * than the baseline (someone deleted a check to make it green). Time is recorded and reported, never gated: it is noisy.
 *
 *   npx tsx scripts/smoke/ca_eval.ts                    run and compare
 *   npx tsx scripts/smoke/ca_eval.ts --update-baseline  accept the current result as the new baseline
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// resolved here so a script can be run from any working directory
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export interface Fixture { name: string; covers: string; script: string }
export interface FixtureResult { name: string; covers: string; passed: boolean; checks: number; ms: number; metrics?: Record<string, number> }
export interface Report { generatedAt: string; fixtures: FixtureResult[] }

/** Metrics held to the baseline: a catch rate may not fall and a false-block rate may not rise. Time is reported, never gated. */
const HIGHER_IS_BETTER = ['catch_rate_on'];
const LOWER_IS_BETTER = ['false_block_rate_on'];

export const FIXTURES: Fixture[] = [
  { name: 'hypothesis-gate', covers: 'wrong-symbol, invented-file', script: 'ca_hypothesis_gate_smoke.ts' },
  { name: 'hypothesis-probes', covers: 'arity, symbol, cite, grep', script: 'ca_hypothesis_probes_smoke.ts' },
  { name: 'stale-evidence', covers: 'stale-cache', script: 'ca_stale_evidence_smoke.ts' },
  { name: 'wiki-claims-and-human-edits', covers: 'stale-wiki, human edits', script: 'wiki_claims_human_smoke.ts' },
  { name: 'rerank-distractor', covers: 'distractor', script: 'ca_rerank_smoke.ts' },
  { name: 'dashboard-showfor', covers: 'dashboard sync', script: 'dashboard_showfor_hypotheses_smoke.ts' },
  { name: 'model-layer-and-commands', covers: 'model-proposed hypotheses, one re-plan, cmd:/test: probes', script: 'ca_model_hypotheses_smoke.ts' },
  { name: 'gate-off-vs-on', covers: 'catch rate and false blocks, gate off vs on', script: 'ca_gate_ab_smoke.ts' },
];

/** A check is a line a smoke script prints as "ok ..." or "PASS ..." ("PASS: ..." is a summary), or the claims count of the dashboard smoke. */
export function countChecks(output: string): number {
  let n = 0;
  for (const l of output.split(/\r?\n/)) {
    if (/^(ok|PASS)\s+\S/.test(l)) n++;
    else { const m = /^(\d+)\/\d+ claims confirmed/.exec(l); if (m) n += Number(m[1]); }
  }
  return n;
}

/** METRIC name=value lines a smoke script prints. */
export function parseMetrics(output: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of output.split(/\r?\n/)) {
    const m = /^METRIC\s+([\w.]+)=(-?[\d.]+)\s*$/.exec(l);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function runOne(fx: Fixture, dir: string): Promise<FixtureResult> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', TSX, path.join(dir, fx.script)], { cwd: path.join(dir, '..', '..'), env: process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', () => resolve({ name: fx.name, covers: fx.covers, passed: false, checks: 0, ms: Date.now() - started }));
    child.on('close', code => {
      const metrics = parseMetrics(out);
      resolve({ name: fx.name, covers: fx.covers, passed: code === 0, checks: countChecks(out), ms: Date.now() - started, ...(Object.keys(metrics).length ? { metrics } : {}) });
    });
  });
}

export async function runFixtures(list: Fixture[], dir: string): Promise<Report> {
  const fixtures: FixtureResult[] = [];
  for (const fx of list) fixtures.push(await runOne(fx, dir));
  return { generatedAt: new Date().toISOString(), fixtures };
}

/** Problems that make the evaluation fail. Empty means it is at least as good as the baseline. */
export function compare(baseline: Report | null, latest: Report): string[] {
  const problems: string[] = [];
  for (const f of latest.fixtures) if (!f.passed) problems.push(`${f.name}: failed`);
  if (!baseline) return problems;
  for (const b of baseline.fixtures) {
    const f = latest.fixtures.find(x => x.name === b.name);
    if (!f) problems.push(`${b.name}: in the baseline but not run`);
    else {
      if (f.checks < b.checks) problems.push(`${b.name}: ${f.checks} passing checks, baseline has ${b.checks} (a check was removed or stopped passing)`);
      for (const k of HIGHER_IS_BETTER) if (b.metrics?.[k] !== undefined && (f.metrics?.[k] ?? -1) < b.metrics[k]) problems.push(`${b.name}: ${k} is ${f.metrics?.[k] ?? 'missing'}, baseline has ${b.metrics[k]}`);
      for (const k of LOWER_IS_BETTER) if (b.metrics?.[k] !== undefined && (f.metrics?.[k] ?? Infinity) > b.metrics[k]) problems.push(`${b.name}: ${k} is ${f.metrics?.[k] ?? 'missing'}, baseline has ${b.metrics[k]}`);
    }
  }
  return problems;
}

function readReport(file: string): Report | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as Report; } catch { return null; }
}

async function main() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const resultsDir = path.join(dir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const latest = await runFixtures(FIXTURES, dir);
  fs.writeFileSync(path.join(resultsDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  // one line per run, kept locally (gitignored) so the trend over runs can be read
  fs.appendFileSync(path.join(resultsDir, 'history.jsonl'), JSON.stringify({ at: latest.generatedAt, fixtures: latest.fixtures.map(f => ({ name: f.name, passed: f.passed, checks: f.checks, ms: f.ms, ...(f.metrics ? { metrics: f.metrics } : {}) })) }) + '\n');

  for (const f of latest.fixtures) {
    console.log(`${f.passed ? 'PASS' : 'FAIL'}  ${f.name.padEnd(30)} ${String(f.checks).padStart(3)} checks  ${(f.ms / 1000).toFixed(1)}s  (${f.covers})`);
    if (f.metrics) console.log('      ' + Object.entries(f.metrics).map(([k, v]) => `${k}=${v}`).join('  '));
  }
  const total = latest.fixtures.reduce((n, f) => n + f.ms, 0);
  console.log(`\n${latest.fixtures.filter(f => f.passed).length}/${latest.fixtures.length} fixtures passed, ${latest.fixtures.reduce((n, f) => n + f.checks, 0)} checks, ${(total / 1000).toFixed(1)}s`);

  const baselineFile = path.join(resultsDir, 'baseline.json');
  if (process.argv.includes('--update-baseline')) {
    if (latest.fixtures.some(f => !f.passed)) { console.error('refusing to record a baseline with a failing fixture'); process.exit(1); }
    fs.writeFileSync(baselineFile, JSON.stringify(latest, null, 2) + '\n');
    console.log('baseline updated');
    return;
  }
  const baseline = readReport(baselineFile);
  const problems = compare(baseline, latest);
  if (baseline) {
    const slower = latest.fixtures.map(f => ({ f, b: baseline.fixtures.find(x => x.name === f.name) })).filter(x => x.b && x.f.ms > x.b.ms * 2 + 2000);
    for (const s of slower) console.log(`note: ${s.f.name} took ${(s.f.ms / 1000).toFixed(1)}s, baseline ${(s.b!.ms / 1000).toFixed(1)}s`);
  } else {
    console.log('note: no baseline.json yet (run with --update-baseline)');
  }
  if (problems.length) { console.error('\n' + problems.map(p => `- ${p}`).join('\n')); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
