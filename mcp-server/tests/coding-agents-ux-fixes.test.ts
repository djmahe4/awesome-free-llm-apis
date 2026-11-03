import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';
import { validateVerifyCommand } from '../src/tools/coding-agents/verify-command.js';
import { formatCodingAgentsMarkdown } from '../src/tools/coding-agents/types.js';

let ws = '';
afterEach(async () => {
  vi.restoreAllMocks();
  if (ws) await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('coding-agents UX & safety enhancements', () => {
  it('validateVerifyCommand accepts python with -p flag while still refusing node -p', () => {
    const pyRes = validateVerifyCommand('python -p myplugin test.py');
    expect(pyRes.ok).toBe(true);

    const nodeRes = validateVerifyCommand('node -p 1');
    expect(nodeRes.ok).toBe(false);
    expect((nodeRes as any).reason).toContain('inline-code flag -p is not allowed');
  });

  it('formatCodingAgentsMarkdown never renders Goal: undefined', () => {
    const md = formatCodingAgentsMarkdown({
      sessionId: 'test-session',
      goal: '',
      pipelineStage: 'completed',
      relevantFiles: [],
      anchors: [],
      patchPlan: [],
      patchSummary: '',
      diagnostics: [],
      applied: false,
    });
    expect(md).not.toContain('Goal: undefined');
    expect(md).not.toContain('- **Goal:**');
  });

  it('formatCodingAgentsMarkdown displays Partial Changes Applied when partialApply is true', () => {
    const md = formatCodingAgentsMarkdown({
      sessionId: 'test-session',
      goal: 'sample goal',
      pipelineStage: 'completed',
      relevantFiles: ['src/a.ts', 'tests/a.test.ts'],
      anchors: [],
      patchPlan: [],
      patchSummary: '',
      diagnostics: [],
      applied: true,
      partialApply: true,
    });
    expect(md).toContain('⚠️ Partial Changes Applied to Disk');
  });

  it('ordinary edit does not leave a stray hypotheses.md in workspace when all hypotheses are confirmed', async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-no-hyp-'));
    await fs.outputFile(path.join(ws, 'src/main.py'), 'def helper(): pass\n');

    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
    const lp = await import('../src/tools/local-llm-patch.js');
    vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({
      success: true,
      patch: 'def helper(): pass\ndef extra(): pass\n',
    } as any);

    const res = await CodingAgentsHandler({
      goal: 'Call `helper` and add extra',
      workspaceRoot: ws,
      targetFiles: ['src/main.py'],
      dryRun: false,
      resolve: { action: 'apply' },
      review: false,
    });

    const hypPath = path.join(ws, 'hypotheses.md');
    const hypExists = await fs.pathExists(hypPath);
    expect(hypExists).toBe(false);
  });

  it('allows applying an unapplied proposal by simply sending goal: "apply"', async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-apply-goal-'));
    await fs.outputFile(path.join(ws, 'src/index.ts'), 'export const val = 1;\n');

    const ollama = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
    const lp = await import('../src/tools/local-llm-patch.js');
    vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({
      success: true,
      patch: 'export const val = 2;\n',
    } as any);

    const sessionId = `apply-goal-${Date.now()}`;

    // Step 1: Run with dryRun: false and no resolve -> returns status: 'proposed'
    let r1: any = await CodingAgentsHandler({
      goal: 'update val to 2',
      workspaceRoot: ws,
      targetFiles: ['src/index.ts'],
      dryRun: false,
      sessionId,
      review: false,
    });

    for (const t0 = Date.now(); r1.status === 'running' && Date.now() - t0 < 60_000;) {
      await new Promise(res => setTimeout(res, 50));
      r1 = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
    }

    expect(r1.status).toBe('proposed');
    expect(r1.applied).toBe(false);

    // Step 2: Call with goal: "apply" and the same sessionId
    const r2: any = await CodingAgentsHandler({
      goal: 'apply',
      workspaceRoot: ws,
      sessionId,
    });

    expect(r2.applied).toBe(true);
    expect(r2.status).toBe('applied');

    const written = await fs.readFile(path.join(ws, 'src/index.ts'), 'utf-8');
    expect(written).toContain('export const val = 2;');
  });
});
