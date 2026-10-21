/**
 * Live smoke test for the capability-aware model router against the REAL local Ollama + llmfit.
 *
 *   npx tsx scripts/smoke/smoke_model_router.ts [--real-calls] [--budget 6]
 *
 * Without --real-calls it only exercises discovery and planning (fast, no GPU load). With it, it also
 * sends a generated "screenshot" to the vision model, has the code model implement it, and calls the
 * embedding model, sampling GPU memory with nvidia-smi so the 6 GB baseline is measured, not assumed.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listModelProfiles, planTask, rankProfiles, vramBudgetGb, resetModelRouterCache, buildProfile,
} from '../../src/services/model-router.js';
import { chatLocal } from '../../src/providers/ollama-local.js';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const REAL = process.argv.includes('--real-calls');
if (arg('budget')) process.env.OLLAMA_VRAM_BUDGET_GB = arg('budget');
const BASE = (process.env.OLLAMA_LOCAL_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');

type Row = { id: string; condition: string; ok: boolean; detail: string; ms?: number; peakVramMb?: number };
const rows: Row[] = [];
const record = (r: Row) => { rows.push(r); console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.condition.padEnd(58)} ${r.detail}${r.peakVramMb !== undefined ? `  [peak VRAM ${r.peakVramMb} MB]` : ''}`); };

function vramUsedMb(): number | null {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  const n = parseInt((r.stdout || '').trim().split('\n')[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Runs fn while sampling GPU memory every 300 ms; returns the peak seen. */
async function withVramPeak<T>(fn: () => Promise<T>): Promise<{ value: T; peakMb: number | null }> {
  let peak: number | null = vramUsedMb();
  let stop = false;
  const sampler = (async () => { while (!stop) { const v = vramUsedMb(); if (v !== null && (peak === null || v > peak)) peak = v; await new Promise(r => setTimeout(r, 300)); } })();
  try { return { value: await fn(), peakMb: peak }; } finally { stop = true; await sampler; if (peak !== null) { const v = vramUsedMb(); if (v !== null && v > peak) peak = v; } }
}

async function unloadAll(): Promise<void> {
  try {
    const ps = await (await fetch(`${BASE}/api/ps`)).json() as any;
    for (const m of ps.models ?? []) {
      await fetch(`${BASE}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
    }
    await new Promise(r => setTimeout(r, 1500));
  } catch { /* ollama down: later steps will say so */ }
}

function makeScreenshotPng(): string {
  const out = path.join(os.tmpdir(), `router-smoke-login-${process.pid}.png`);
  const py = [
    'from PIL import Image, ImageDraw, ImageFont',
    'img = Image.new("RGB", (640, 420), "white"); d = ImageDraw.Draw(img)',
    'try: f = ImageFont.truetype("arial.ttf", 26)',
    'except Exception: f = ImageFont.load_default()',
    'd.text((220, 30), "Sign in", fill="black", font=f)',
    'd.rectangle((120, 100, 520, 150), outline="black", width=3); d.text((130, 112), "Email", fill="gray", font=f)',
    'd.rectangle((120, 190, 520, 240), outline="black", width=3); d.text((130, 202), "Password", fill="gray", font=f)',
    'd.rectangle((220, 290, 420, 350), fill="#2563eb"); d.text((265, 305), "Log in", fill="white", font=f)',
    `img.save(r"${out}")`,
  ].join('\n');
  const r = spawnSync('python', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not draw the screenshot: ${r.stderr}`);
  return out;
}

async function main() {
  console.log(`Ollama ${BASE} | budget ${vramBudgetGb()} GB | real calls: ${REAL}\n`);

  // S1 discovery with the real llmfit hook
  resetModelRouterCache();
  let t = Date.now();
  const profiles = await listModelProfiles();
  record({ id: 'S1', condition: 'discovery lists installed models with real capabilities', ok: profiles.length > 0 && profiles.every(p => p.capabilitySource === 'show'), detail: `${profiles.length} models in ${Date.now() - t} ms (${profiles.map(p => `${p.name.split('/').pop()}[${p.capabilities.join(',')}]`).join(' ')})` });
  const matched = profiles.filter(p => p.llmfitModel);
  record({ id: 'S1b', condition: 'llmfit hook matched the installed models to its catalog', ok: matched.length >= profiles.length - 1, detail: `${matched.length}/${profiles.length} matched (${profiles.map(p => `${p.name.split('/').pop()}->${p.llmfitModel ?? 'none'}`).join(', ')})` });

  // S2 planning
  const shot = planTask(profiles, { hasImages: true, kind: 'code' });
  record({ id: 'S2', condition: 'screenshot->code: vision model looks, code model implements', ok: shot.missing.length === 0 && /vl|vision/i.test(shot.stages[0].model ?? '') && /coder/i.test(shot.stages[1].model ?? ''), detail: shot.stages.map(s => `${s.stage}=${s.model}`).join(' -> ') });
  const code = planTask(profiles, { kind: 'code' });
  record({ id: 'S2b', condition: 'plain code task picks a code model, never an embedder or a vision model', ok: /coder/i.test(code.stages[0].model ?? ''), detail: String(code.stages[0].model) });
  const emb = planTask(profiles, { kind: 'embedding' });
  record({ id: 'S2c', condition: 'embedding task picks an embedding model', ok: /bge|nomic|embed/i.test(emb.stages[0].model ?? ''), detail: String(emb.stages[0].model) });
  const general = planTask(profiles, { kind: 'general' });
  record({ id: 'S2d', condition: 'general task avoids over-budget and embedding models', ok: !!general.stages[0].model && !/bge|nomic/i.test(general.stages[0].model), detail: String(general.stages[0].model) });

  // S3 budget sweeps
  for (const b of [2, 4, 6, 8]) {
    const r = rankProfiles(profiles, 'code', b);
    const fits = r.filter(x => x.fitsBudget).map(x => x.name.split('/').pop());
    const plan = planTask(profiles, { kind: 'code' }, b);
    record({ id: `S3-${b}`, condition: `budget ${b} GB: only fitting models are eligible`, ok: plan.stages[0].model === null ? fits.length === 0 || plan.missing.includes('code') : r.find(x => x.name === plan.stages[0].model)!.fitsBudget, detail: `fits=[${fits.join(', ')}] code->${plan.stages[0].model ?? 'NONE (missing)'}` });
  }

  // S4 degraded conditions
  const textOnly = profiles.filter(p => !p.capabilities.includes('vision'));
  const noVision = planTask(textOnly, { hasImages: true, kind: 'code' });
  record({ id: 'S4', condition: 'no vision model installed: reported as missing, code stage still planned', ok: noVision.missing.includes('vision') && !!noVision.stages[1].model, detail: `missing=[${noVision.missing}] implement=${noVision.stages[1].model}` });
  const guessed = profiles.map(p => buildProfile(p.name, { size: (p.sizeGb ?? 0) * 1e9 }));
  const guessedPlan = planTask(guessed, { hasImages: true, kind: 'code' });
  record({ id: 'S4b', condition: '/api/show unavailable: capabilities guessed from names still route correctly', ok: guessedPlan.missing.length === 0 && /vl/i.test(guessedPlan.stages[0].model ?? ''), detail: guessedPlan.stages.map(s => `${s.stage}=${s.model}`).join(' -> ') });
  const [a, b] = await Promise.all([Promise.resolve(planTask(profiles, { hasImages: true, kind: 'code' })), Promise.resolve(planTask(profiles, { hasImages: true, kind: 'code' }))]);
  record({ id: 'S4c', condition: 'planning is deterministic (same input, same plan)', ok: JSON.stringify(a) === JSON.stringify(b), detail: 'two concurrent plans equal' });
  const overBudgetNeverChosen = profiles.filter(p => (p.memoryGb ?? 0) > vramBudgetGb()).every(p => !shot.stages.some(s => s.model === p.name));
  record({ id: 'S4d', condition: 'models over the VRAM budget are never planned', ok: overBudgetNeverChosen, detail: profiles.filter(p => (p.memoryGb ?? 0) > vramBudgetGb()).map(p => `${p.name.split('/').pop()}(~${p.memoryGb}GB)`).join(', ') || 'none installed over budget' });

  if (!REAL) { finish(); return; }

  // S5 real staged run
  const vlName = shot.stages[0].model!; const coderName = shot.stages[1].model!;
  await unloadAll();
  const baseline = vramUsedMb();
  const png = makeScreenshotPng();
  const b64 = fs.readFileSync(png).toString('base64');

  t = Date.now();
  const vl = await withVramPeak(() => chatLocal(vlName, [{ role: 'user', content: 'Describe this UI screenshot precisely: list every visible control (inputs, buttons) with its label, in top-to-bottom order.', images: [b64] }], { temperature: 0, maxTokens: 400, keepAlive: 0 }));
  const desc = vl.value.content;
  record({ id: 'S5', condition: 'real: vision model describes the screenshot (unloads after)', ok: /email/i.test(desc) && /password/i.test(desc) && /(log ?in|sign ?in)/i.test(desc), detail: JSON.stringify(desc.slice(0, 110)), ms: Date.now() - t, peakVramMb: vl.peakMb ?? undefined });
  await new Promise(r => setTimeout(r, 1500));
  record({ id: 'S5b', condition: 'real: VRAM returns to baseline after the vision stage (keep_alive 0)', ok: (vramUsedMb() ?? 0) <= (baseline ?? 0) + 600, detail: `baseline ${baseline} MB -> now ${vramUsedMb()} MB` });

  t = Date.now();
  const impl = await withVramPeak(() => chatLocal(coderName, [
    { role: 'system', content: 'You write HTML. Reply with ONLY one complete HTML snippet, no explanation.' },
    { role: 'user', content: `Implement this UI as HTML with a form:\n${desc}` },
  ], { temperature: 0, maxTokens: 600, keepAlive: 0 }));
  record({ id: 'S6', condition: 'real: code model turns the description into a form', ok: /<form/i.test(impl.value.content) && /<input/i.test(impl.value.content) && /<button/i.test(impl.value.content), detail: `${impl.value.content.length} chars, promptTruncated=${impl.value.promptTruncated}`, ms: Date.now() - t, peakVramMb: impl.peakMb ?? undefined });

  const limitMb = vramBudgetGb() * 1024;
  const stagedPeak = Math.max(vl.peakMb ?? 0, impl.peakMb ?? 0);
  record({ id: 'S7', condition: `real: staged peak VRAM stays within the ${vramBudgetGb()} GB budget`, ok: stagedPeak > 0 && stagedPeak <= limitMb + (baseline ?? 0), detail: `peak ${stagedPeak} MB (limit ${Math.round(limitMb)} MB above a ${baseline} MB baseline)` });

  // S8 resident together (no unload) to show why keep_alive 0 matters
  await unloadAll();
  const both = await withVramPeak(async () => {
    await chatLocal(vlName, [{ role: 'user', content: 'Say OK.', images: [b64] }], { temperature: 0, maxTokens: 5, keepAlive: '5m' });
    await chatLocal(coderName, [{ role: 'user', content: 'Say OK.' }], { temperature: 0, maxTokens: 5, keepAlive: '5m' });
  });
  record({ id: 'S8', condition: 'info: both models resident at once (what keep_alive 0 avoids)', ok: true, detail: `peak ${both.peakMb} MB ${both.peakMb && both.peakMb > limitMb ? '(EXCEEDS the budget: unload between stages)' : '(fits)'}` });
  await unloadAll();

  // S9 embedding
  t = Date.now();
  const emName = emb.stages[0].model!;
  const er = await withVramPeak(async () => (await (await fetch(`${BASE}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: emName, input: ['hello world'], keep_alive: 0 }) })).json() as any));
  const vec = er.value?.embeddings?.[0];
  record({ id: 'S9', condition: 'real: embedding model returns a vector', ok: Array.isArray(vec) && vec.length > 100, detail: `${emName} dim=${vec?.length}`, ms: Date.now() - t, peakVramMb: er.peakMb ?? undefined });

  finish();
}

function finish() {
  const failed = rows.filter(r => !r.ok);
  const dir = path.join(process.cwd(), 'scratch'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `smoke-model-router-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\n${rows.length - failed.length}/${rows.length} passed. Report: ${out}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(e => { console.error('smoke crashed:', e); process.exit(2); });
void spawn;
