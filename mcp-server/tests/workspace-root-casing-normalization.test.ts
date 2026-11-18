import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';
import { normalizeCodingAgentsHttpInput } from '../src/tools/coding-agents/http-input.js';
import { useFreeLLM } from '../src/tools/use-free-llm.js';
import { removeDir } from './helpers/temp-dir.js';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await removeDir(root);
});

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-casing-'));
  roots.push(root);
  return root;
}

describe('TDD: Workspace Root Casing Normalization (workspaceRoot vs workspace_root)', () => {
  it('CodingAgentsHandler resolves workspace_root (snake_case) instead of falling back to cwd', async () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'calc.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

    // Call with snake_case workspace_root
    const result = await CodingAgentsHandler({
      goal: 'inspect calc.ts add function',
      workspace_root: root,
      dryRun: true,
      topKFiles: 1,
    } as any);

    expect(result.relevantFiles).toContain('src/calc.ts');
    // Session ID must be derived from the provided root, not process.cwd()
    const { stableWorkspaceSessionId } = await import('../src/tools/coding-agents/session-wiring.js');
    expect(result.sessionId).toBe(stableWorkspaceSessionId(root));
    expect(result.sessionId).not.toBe(stableWorkspaceSessionId(process.cwd()));
  });

  it('normalizeCodingAgentsHttpInput maps workspace_root to workspaceRoot', () => {
    const root = tempWorkspace();
    const parsed = normalizeCodingAgentsHttpInput({
      goal: 'test goal',
      workspace_root: root,
    }, process.cwd());

    expect('input' in parsed).toBe(true);
    if ('input' in parsed) {
      expect(parsed.input.workspaceRoot).toBe(root);
      expect(parsed.input.workspaceRoot).not.toBe(process.cwd());
    }
  });

  it('useFreeLLM accepts workspaceRoot (camelCase) and derives wsHash for it', async () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'demo.ts'), 'export const DEMO = 1;\n');

    const result = await useFreeLLM({
      messages: [{ role: 'user', content: 'status' }],
      workspaceRoot: root,
      action: 'status',
      agentic: true,
    } as any);

    const { WorkspaceScanner } = await import('../src/cache/workspace.js');
    const expectedHash = await new WorkspaceScanner(process.cwd()).getWorkspaceHash(root);
    const expectedSessionId = `ws-${expectedHash.substring(0, 16)}`;

    // Result should match the expected session ID derived from root, not cwd
    expect(result.choices[0].message.content).toContain(expectedSessionId);
  });
});
