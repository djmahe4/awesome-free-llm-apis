import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanContract, contractPrompt, writeContract } from '../src/tools/coding-agents/contract-writer.js';
import { extractCallSites } from '../src/tools/coding-agents/call-sites.js';
import { contractTailOf, deriveExportSteps, exportStepPreparer } from '../src/tools/coding-agents/export-steps.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const TEST_SOURCE = "import { buildThing, readThing } from '../src/mod.js';\nbuildThing('s', 'g', { messages: [] });\nreadThing(db, 'w');\n";
function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'tests/mod.test.ts'), TEST_SOURCE);
  fs.writeFileSync(path.join(dir, 'src/mod.ts'), '');
  return dir;
}
const REPLY = [
  'Here is the contract:',
  '```',
  '- buildThing(sessionId: string, goal: string, thread: { messages: Array }) returns a ThoughtDag',
  '- readThing(path) returns an array, or null when `missing`',
  '- unrelated(x) does something else',
  'Some rambling sentence about buildThing without a bullet.',
  '```',
].join('\n');

describe('cleanContract', () => {
  it('keeps only bullets that name an export, drops fences, prose and backticks', () => {
    expect(cleanContract(REPLY, ['buildThing', 'readThing']).split('\n')).toEqual([
      '- buildThing(sessionId: string, goal: string, thread: { messages: Array }) returns a ThoughtDag',
      '- readThing(path) returns an array, or null when missing',
    ]);
  });
  it('returns nothing for a reply with no usable bullet and caps long ones', () => {
    expect(cleanContract('I think it works', ['buildThing'])).toBe('');
    expect(cleanContract(`- buildThing ${'x'.repeat(5000)}`, ['buildThing'], 100)).toContain('[contract truncated]');
  });
});

describe('contractPrompt', () => {
  it('asks per export, and includes the data shape only when given', () => {
    const p = contractPrompt({ target: 'src/mod.ts', names: ['a', 'b'], testSpec: '[Tests]', shapes: '{ messages: [...] }' });
    expect(p).toContain('Exports to describe: a, b');
    expect(p).toContain('Real shape of the data');
    expect(contractPrompt({ target: 'x', names: ['a'], testSpec: 't' })).not.toContain('Real shape');
  });
});

describe('writeContract', () => {
  const base = (root: string) => ({ goal: 'g', verifyCommand: 'npx vitest run tests/mod.test.ts', targetFiles: ['src/mod.ts'], workspaceRoot: root, contractModel: 'big-model' }) as any;
  it('is off without contractModel, skipped when the model is not installed, and never throws', async () => {
    const root = ws();
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
    const chat = vi.fn(async () => ({ content: REPLY }));
    expect((await writeContract({ ...base(root), contractModel: undefined }, root, 'src/mod.ts', ['buildThing'], chat)).text).toBe('');
    expect((await writeContract(base(root), root, 'src/mod.ts', ['buildThing'], chat)).text).toBe('');
    expect(chat).not.toHaveBeenCalled();
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['big-model:9b']);
    expect((await writeContract(base(root), root, 'src/mod.ts', ['buildThing'], async () => { throw new Error('boom'); })).text).toBe('');
  });
  it('calls the resolved model locally with the tests in the prompt', async () => {
    const root = ws();
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['big-model:9b']);
    const chat = vi.fn(async (_m: string, _msgs: any[], _o: any) => ({ content: REPLY }));
    const out = await writeContract(base(root), root, 'src/mod.ts', ['buildThing', 'readThing'], chat);
    expect(chat.mock.calls[0][0]).toBe('big-model:9b');
    expect(chat.mock.calls[0][1][1].content).toContain("buildThing('s', 'g', { messages: [] })");
    expect(chat.mock.calls[0][2]).toMatchObject({ temperature: 0, think: false });
    expect(out.text).toContain('buildThing(sessionId');
  });
  it('drops a reply bullet that contradicts the test calls, and reports it', async () => {
    const root = ws();
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['big-model:9b']);
    const wrong = '- buildThing(messages: any[]) returns a DAG object';
    const right = '- readThing(db, workspace) returns an array of session objects';
    const sites = extractCallSites(TEST_SOURCE, ['buildThing', 'readThing']);
    const out = await writeContract(base(root), root, 'src/mod.ts', ['buildThing', 'readThing'], async () => ({ content: `${wrong}\n${right}` }), sites);
    expect(out.text).toBe(right);
    expect(out.dropped).toEqual([wrong]);
  });
});

describe('export steps carry the contract', () => {
  it('always carries the literal call sites, with no model configured', async () => {
    const root = ws();
    const steps = await deriveExportSteps({ goal: 'Rebuild', verifyCommand: 'npx vitest run tests/mod.test.ts', targetFiles: ['src/mod.ts'], workspaceRoot: root } as any);
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s).toContain('[Contract read from the tests]');
      expect(s).toContain("- called as buildThing('s', 'g', { messages: [] })");
      expect(s).toContain("- called as readThing(db, 'w')");
    }
  });
  it('adds checked model bullets on top, and keeps the contract when the last step becomes fix-the-check', async () => {
    const root = ws();
    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['big-model:9b']);
    vi.spyOn(ollama, 'chatLocal').mockResolvedValue({ content: `${'- buildThing(messages: any[]) wrong'}\n- readThing(db, workspace) returns an array` } as any);
    const input = { goal: 'Rebuild', verifyCommand: 'npx vitest run tests/mod.test.ts', targetFiles: ['src/mod.ts'], workspaceRoot: root, contractModel: 'big-model' } as any;
    const steps = await deriveExportSteps(input);
    for (const s of steps) {
      expect(s).toContain('(return shapes by big-model, checked against the calls)');
      expect(s).toContain('- readThing(db, workspace) returns an array');
      expect(s).not.toContain('messages: any[]');
    }
    expect(contractTailOf(steps[1])).toContain('- called as buildThing(');
    fs.writeFileSync(path.join(root, 'src/mod.ts'), 'export function buildThing() {}\nexport function readThing() {}\n');
    const last = await exportStepPreparer(input)(steps[1], true);
    expect(last).toContain('correct the existing code so the tests pass');
    expect(last).toContain('- called as buildThing(');
  });
});
