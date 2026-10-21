import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { validateVerifyCommand, runVerifyCommand } from '../src/tools/coding-agents/verify-command.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

async function makeWs(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-verify-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, 'utf-8');
  }
  return dir;
}

describe('validateVerifyCommand', () => {
  it('accepts test-runner style commands', () => {
    for (const c of ['npx vitest run tests/a.test.ts', 'npm test', 'npm run test:unit', 'pytest -q tests/test_a.py', 'node check.js', 'go test ./...', 'cargo test']) {
      expect(validateVerifyCommand(c)).toMatchObject({ ok: true });
    }
  });
  it('rejects shell metacharacters, quotes, unknown executables and inline-code flags', () => {
    const bad = ['npm test; rm -rf /', 'npm test && curl x', 'npm test | tee out', 'echo hi > f', 'npm test `id`', 'npm test $(id)', 'node -e "1"', 'node --eval 1', 'python -c 1', 'rm -rf .', 'bash run.sh', 'npx vitest "a b"', '', '   '];
    for (const c of bad) expect(validateVerifyCommand(c), c).toMatchObject({ ok: false });
  });
});

describe('runVerifyCommand', () => {
  let ws = '';
  afterEach(async () => { if (ws) await fs.remove(ws); ws = ''; });

  it('reports exit 0 as ok and captures output', async () => {
    ws = await makeWs({ 'ok.js': 'console.log("all green");' });
    const r = await runVerifyCommand('node ok.js', ws);
    expect(r).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(r.outputTail).toContain('all green');
  });
  it('reports a non-zero exit with the failing output tail', async () => {
    ws = await makeWs({ 'bad.js': 'console.error("expected 2 got 3"); process.exit(1);' });
    const r = await runVerifyCommand('node bad.js', ws);
    expect(r).toMatchObject({ ok: false, exitCode: 1, timedOut: false });
    expect(r.outputTail).toContain('expected 2 got 3');
  });
  it('kills a command that exceeds the timeout and says so', async () => {
    ws = await makeWs({ 'hang.js': 'setInterval(() => {}, 1000);' });
    const r = await runVerifyCommand('node hang.js', ws, { timeoutMs: 600 });
    expect(r).toMatchObject({ ok: false, timedOut: true });
  }, 15000);
  it('caps captured output', async () => {
    ws = await makeWs({ 'loud.js': 'for (let i = 0; i < 200000; i++) console.log("line " + i);' });
    const r = await runVerifyCommand('node loud.js', ws);
    expect(r.outputTail.length).toBeLessThanOrEqual(4096);
    expect(r.ok).toBe(true);
  }, 20000);
  it('refuses an invalid command without running anything', async () => {
    ws = await makeWs({});
    const r = await runVerifyCommand('node a.js; echo pwned', ws);
    expect(r).toMatchObject({ ok: false, rejected: true });
  });
});

describe('CodingAgentsHandler verifyCommand gate', () => {
  let ws = '';
  afterEach(async () => { if (ws) await fs.remove(ws); ws = ''; });

  const SRC = 'src/app.ts';
  const ORIGINAL = ['export function greet() {', '  return "hello";', '}'].join('\n');
  // check.js fails when the source contains BAD
  const CHECK = 'const s = require("fs").readFileSync("src/app.ts", "utf8"); if (s.includes("BAD")) { console.error("found BAD in app.ts"); process.exit(1); }';

  const apply = (extra: Record<string, unknown>, out: string) => CodingAgentsHandler({
    goal: 'change the greeting',
    workspaceRoot: ws,
    dryRun: false,
    topKFiles: 1,
    targetFiles: [SRC],
    astEditOps: [{ pat: '"hello"', out }],
    resolve: { action: 'apply' },
    ...extra,
  } as any);

  it('keeps a patch that passes the check', async () => {
    ws = await makeWs({ [SRC]: ORIGINAL, 'check.js': CHECK });
    const r: any = await apply({ verifyCommand: 'node check.js' }, '"hi"');
    expect(r.applied).toBe(true);
    expect(r.verification).toMatchObject({ ok: true, baselineOk: true, command: 'node check.js' });
    expect(await fs.readFile(path.join(ws, SRC), 'utf-8')).toContain('"hi"');
  });

  it('rolls back a patch that makes a previously passing check fail, and reports why', async () => {
    ws = await makeWs({ [SRC]: ORIGINAL, 'check.js': CHECK });
    const r: any = await apply({ verifyCommand: 'node check.js' }, '"BAD"');
    expect(r.applied).toBe(false);
    expect(r.verification).toMatchObject({ ok: false, baselineOk: true, exitCode: 1 });
    expect(r.verification.outputTail).toContain('found BAD');
    expect(r.diagnostics.some((d: any) => d.source === 'verify-command' && d.severity === 'error')).toBe(true);
    expect(await fs.readFile(path.join(ws, SRC), 'utf-8')).toBe(ORIGINAL);
  });

  it('does not blame the patch for a check that was already failing: patch kept, warning only', async () => {
    ws = await makeWs({ [SRC]: ORIGINAL.replace('hello', 'BAD'), 'check.js': CHECK });
    const r2: any = await CodingAgentsHandler({
      goal: 'change the greeting', workspaceRoot: ws, dryRun: false, topKFiles: 1, targetFiles: [SRC],
      astEditOps: [{ pat: '"BAD"', out: '"still BAD"' }], resolve: { action: 'apply' }, verifyCommand: 'node check.js',
    } as any);
    expect(r2.verification).toMatchObject({ baselineOk: false });
    expect(r2.applied).toBe(true);
    expect(r2.diagnostics.some((d: any) => d.source === 'verify-command' && d.severity === 'warning')).toBe(true);
  });

  it('an invalid verifyCommand stops the run before anything is written', async () => {
    ws = await makeWs({ [SRC]: ORIGINAL });
    const r: any = await apply({ verifyCommand: 'node check.js; echo pwned' }, '"hi"');
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/verifyCommand/);
    expect(await fs.readFile(path.join(ws, SRC), 'utf-8')).toBe(ORIGINAL);
  });

  it('without verifyCommand behaviour is unchanged', async () => {
    ws = await makeWs({ [SRC]: ORIGINAL });
    const r: any = await apply({}, '"hi"');
    expect(r.applied).toBe(true);
    expect(r.verification).toBeUndefined();
  });
});
