import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { isTestFile, isExecutableSurface, assessPatchesForVerify, buildRepairBrief, withFeedback } from '../src/tools/coding-agents/verify-guard.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

describe('isTestFile', () => {
  it.each(['tests/a.test.ts', 'src/a.spec.js', 'test_a.py', 'pkg/a_test.go', '__tests__/x.js', 'tests/helpers/mock.ts', 'SRC/A.TEST.TS'])('%s is a test', p => {
    expect(isTestFile(p)).toBe(true);
  });
  it.each(['src/app.ts', 'src/contest.ts', 'src/latest.ts', 'package.json', 'scripts/build.ts'])('%s is not a test', p => {
    expect(isTestFile(p)).toBe(false);
  });
});

describe('isExecutableSurface (files a check would execute, or that hook the toolchain)', () => {
  it.each([
    'tests/a.test.ts', 'src/a.spec.js', 'test_a.py', 'pkg/a_test.go', '__tests__/x.js', 'tests/helpers/mock.ts',
    'package.json', 'vitest.config.ts', 'jest.config.js', 'pytest.ini', 'conftest.py', 'tox.ini', 'Makefile', 'Cargo.toml',
    '.husky/pre-commit', '.github/workflows/ci.yml', '.git/hooks/pre-push', 'scripts/build.ts', 'run.sh', 'x.bat', 'x.ps1', 'x.cmd',
    'SRC\\A.TEST.TS', 'check.js', './check.js',
  ])('%s is flagged', p => { expect(isExecutableSurface(p, ['check.js'])).toBe(true); });

  it.each(['src/app.ts', 'lib/util.py', 'pkg/server.go', 'README.md', 'src/contest.ts', 'src/latest.ts', 'src/attest.ts'])('%s is ordinary production code', p => {
    expect(isExecutableSurface(p, [])).toBe(false);
  });
});

describe('assessPatchesForVerify', () => {
  const ok = { filePath: 'src/app.ts', before: 'export const a = 1;\n', after: 'export const a = 2;\n', isNew: false };

  it('a plain production edit is not suspicious', () => {
    expect(assessPatchesForVerify([ok], 'npx vitest run tests/a.test.ts')).toMatchObject({ suspicious: false, reasons: [] });
  });
  it('changing a test is NOT suspicious: it is allowed, but flagged for a manual run', () => {
    const r = assessPatchesForVerify([ok, { ...ok, filePath: 'tests/a.test.ts' }], 'npm test');
    expect(r).toMatchObject({ suspicious: false, manualRun: true });
    expect(r.manualReasons.join(' ')).toMatch(/does not run tests it wrote/);
    const created = assessPatchesForVerify([{ filePath: 'tests/new.test.ts', before: null, after: 'it("x", () => {})', isNew: true }], 'npm test');
    expect(created).toMatchObject({ suspicious: false, manualRun: true });
    expect(created.manualReasons.join(' ')).toMatch(/created/);
  });
  it('a plain production edit needs no manual run', () => {
    expect(assessPatchesForVerify([ok], 'npm test')).toMatchObject({ suspicious: false, manualRun: false });
  });
  it('a script named by the command, or a toolchain/hook file, is suspicious (withheld)', () => {
    expect(assessPatchesForVerify([{ ...ok, filePath: 'check.js' }], 'node check.js').suspicious).toBe(true);
    expect(assessPatchesForVerify([{ ...ok, filePath: 'package.json' }], 'npm test').suspicious).toBe(true);
    expect(assessPatchesForVerify([ok, { ...ok, filePath: '.husky/pre-commit' }], 'npm test').reasons.join(' ')).toMatch(/\.husky/);
  });
  it('a NEW script or hook file is suspicious (withheld)', () => {
    const r = assessPatchesForVerify([{ filePath: 'scripts/run.sh', before: null, after: 'echo hi', isNew: true }], 'npm test');
    expect(r.suspicious).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/CREATE a script/);
  });
  it('added destructive or process-spawning calls are suspicious even in ordinary files', () => {
    for (const added of ['fs.rmSync(dir, { recursive: true })', 'require("child_process").exec(x)', 'shutil.rmtree(p)', 'os.system("x")', 'Remove-Item -Recurse x', 'rimraf(p)', 'fs.unlinkSync(f)', 'spawn("x", [], { shell: true })']) {
      const r = assessPatchesForVerify([{ ...ok, after: ok.before + added + '\n' }], 'npm test');
      expect(r.suspicious, added).toBe(true);
    }
  });
  it('a destructive call that was already there is not newly suspicious; emptying a whole file is', () => {
    const had = 'fs.rmSync(tmp);\n';
    expect(assessPatchesForVerify([{ ...ok, before: had, after: had + 'const b = 2;\n' }], 'npm test').suspicious).toBe(false);
    expect(assessPatchesForVerify([{ ...ok, after: '' }], 'npm test').suspicious).toBe(true);
  });
  it('ordinary regex.exec in production code is not treated as process spawning', () => {
    expect(assessPatchesForVerify([{ ...ok, after: ok.before + 'const m = /a/.exec(s);\n' }], 'npm test').suspicious).toBe(false);
  });
});

describe('buildRepairBrief (debugger persona)', () => {
  const vitestOut = [
    ' FAIL  tests/ssrf.test.ts > isPrivateAddress > 100.64.0.1 is private',
    'AssertionError: expected false to be true // Object.is equality',
    ' ❯ tests/ssrf.test.ts:12:45',
    ' ❯ src/utils/ssrf-guard.ts:20:5',
    ' Test Files  1 failed (1)',
  ].join('\n');

  it('keeps failing test names, assertion lines and only stack frames that point into patched files', () => {
    const brief = buildRepairBrief({ command: 'npx vitest run tests/ssrf.test.ts', exitCode: 1, outputTail: vitestOut, patchedFiles: ['src/utils/ssrf-guard.ts'] });
    expect(brief).toMatch(/debugger/i);
    expect(brief).toContain('isPrivateAddress > 100.64.0.1 is private');
    expect(brief).toContain('expected false to be true');
    expect(brief).toContain('src/utils/ssrf-guard.ts:20');
    expect(brief).not.toContain('tests/ssrf.test.ts:12');
    expect(brief).toMatch(/do not edit tests/i);
    expect(brief).toMatch(/do not run commands/i);
  });
  it('understands pytest and node failures too', () => {
    const py = buildRepairBrief({ command: 'pytest', exitCode: 1, outputTail: 'FAILED tests/test_a.py::test_x - AssertionError: assert 3 == 2\n', patchedFiles: ['a.py'] });
    expect(py).toContain('test_a.py::test_x');
    const node = buildRepairBrief({ command: 'node check.js', exitCode: 1, outputTail: 'found BAD in app.ts error\n    at Object.<anonymous> (C:\\w\\src\\app.ts:3:9)\n', patchedFiles: ['src/app.ts'] });
    expect(node).toContain('found BAD in app.ts');
    expect(node).toContain('app.ts:3');
  });
  it('falls back to compacted raw output when nothing looks like a failure line', () => {
    const out = ['starting', ...Array.from({ length: 80 }, (_, i) => `step ${i} done in ${i + 5}ms`), 'finished'].join('\n');
    const brief = buildRepairBrief({ command: 'x', exitCode: 2, outputTail: out, patchedFiles: [] });
    expect(brief).toMatch(/similar lines collapsed/);
    expect(brief).toContain('finished');
  });
  it('is bounded, and says so for a timeout or an empty run', () => {
    const big = buildRepairBrief({ command: 'x', exitCode: 1, outputTail: 'FAIL a\n'.repeat(5000), patchedFiles: [] });
    expect(big.length).toBeLessThanOrEqual(2100);
    expect(buildRepairBrief({ command: 'npm test', exitCode: null, timedOut: true, outputTail: '', patchedFiles: [] })).toMatch(/timed out/i);
    expect(buildRepairBrief({ command: 'npm test', exitCode: 1, outputTail: '', patchedFiles: [] })).toMatch(/printed nothing/i);
  });
});

describe('withFeedback', () => {
  it('appends a bounded brief and leaves the goal alone when there is none', () => {
    expect(withFeedback('do x')).toBe('do x');
    expect(withFeedback('do x', '   ')).toBe('do x');
    expect(withFeedback('do x', 'expected 1 to be 2')).toMatch(/do x[\s\S]*expected 1 to be 2/);
    expect(withFeedback('g', 'y'.repeat(9000)).length).toBeLessThan(2300);
  });
});

describe('CodingAgentsHandler: suspicious edits are withheld for the user to verify', () => {
  let ws = '';
  afterEach(async () => { if (ws) await fs.remove(ws); ws = ''; });

  async function make(files: Record<string, string>) {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-guard-'));
    for (const [rel, c] of Object.entries(files)) { await fs.ensureDir(path.dirname(path.join(ws, rel))); await fs.writeFile(path.join(ws, rel), c); }
  }
  const run = (extra: Record<string, unknown>) => CodingAgentsHandler({ goal: 'edit', workspaceRoot: ws, dryRun: false, topKFiles: 1, resolve: { action: 'apply' }, ...extra } as any);

  it('an edit to a test file IS applied, but the check is never executed by the agent; the user is told what to run', async () => {
    // check.js would leave a marker file if it ran; it must not.
    await make({ 'tests/a.test.js': 'const x = "old";\n', 'check.js': 'require("fs").writeFileSync("ran.marker", "1");' });
    const r: any = await run({ targetFiles: ['tests/a.test.js'], astEditOps: [{ pat: '"old"', out: '"new"' }], verifyCommand: 'node check.js' });
    expect(r.applied).toBe(true);
    expect(r.verification).toMatchObject({ status: 'needs_user', command: 'node check.js' });
    expect(r.verification.reasons.join(' ')).toMatch(/tests\/a\.test\.js/);
    expect(r.message).toMatch(/node check\.js/);
    expect(r.message).toMatch(/verifyReport/);
    expect(await fs.readFile(path.join(ws, 'tests/a.test.js'), 'utf-8')).toBe('const x = "new";\n');
    expect(await fs.pathExists(path.join(ws, 'ran.marker'))).toBe(false);
  });

  it('an edit to the script the command runs is withheld (not applied, not executed)', async () => {
    await make({ 'check.js': 'const a = "old"; require("fs").writeFileSync("ran.marker", "1");' });
    const r: any = await run({ targetFiles: ['check.js'], astEditOps: [{ pat: '"old"', out: '"new"' }], verifyCommand: 'node check.js' });
    expect(r.applied).toBe(false);
    expect(r.verification.status).toBe('needs_user');
    expect(await fs.readFile(path.join(ws, 'check.js'), 'utf-8')).toContain('"old"');
    expect(await fs.pathExists(path.join(ws, 'ran.marker'))).toBe(false);
  });

  it('an edit that adds a destructive call is withheld the same way', async () => {
    await make({ 'src/app.js': 'const dir = "a";\nconsole.log(dir);\n', 'check.js': 'process.exit(0)' });
    const r: any = await run({ targetFiles: ['src/app.js'], astEditOps: [{ pat: 'console.log($$$A)', out: 'require("fs").rmSync($$$A, { recursive: true })' }], verifyCommand: 'node check.js' });
    expect(r.applied).toBe(false);
    expect(r.verification.status).toBe('needs_user');
  });

  it('a failed gate rolls back and returns a debugger brief with the failing output', async () => {
    await make({ 'src/app.ts': 'export const v = "hello";\n', 'check.js': 'const s=require("fs").readFileSync("src/app.ts","utf8"); if (s.includes("BAD")) { console.error("found BAD in src/app.ts"); process.exit(1); }' });
    const r: any = await run({ targetFiles: ['src/app.ts'], astEditOps: [{ pat: '"hello"', out: '"BAD"' }], verifyCommand: 'node check.js' });
    expect(r.applied).toBe(false);
    expect(r.verification).toMatchObject({ status: 'regressed', ok: false, baselineOk: true });
    expect(r.verification.repairBrief).toContain('found BAD in src/app.ts');
    expect(r.verification.repairBrief).toMatch(/debugger/i);
    expect(await fs.readFile(path.join(ws, 'src/app.ts'), 'utf-8')).toBe('export const v = "hello";\n');
  });

  it('verifyReport: the user pastes the output of their own test run; failure becomes a debugger brief, success a confirmation, and nothing on disk changes', async () => {
    await make({ 'src/app.ts': 'export const v = 1;\n' });
    const failed: any = await CodingAgentsHandler({ goal: 'ssrf', workspaceRoot: ws, verifyReport: { exitCode: 1, command: 'npm test', output: ' FAIL tests/a.test.ts > t\nAssertionError: expected 1 to be 2\n ❯ src/app.ts:1:1' }, targetFiles: ['src/app.ts'] } as any);
    expect(failed.verification).toMatchObject({ status: 'user_failed' });
    expect(failed.verification.repairBrief).toContain('expected 1 to be 2');
    expect(failed.verification.repairBrief).toContain('src/app.ts:1');
    const passed: any = await CodingAgentsHandler({ goal: 'ssrf', workspaceRoot: ws, verifyReport: { exitCode: 0, command: 'npm test', output: 'ok' } } as any);
    expect(passed.verification).toMatchObject({ status: 'user_passed' });
    expect(await fs.readFile(path.join(ws, 'src/app.ts'), 'utf-8')).toBe('export const v = 1;\n');
  });
});
