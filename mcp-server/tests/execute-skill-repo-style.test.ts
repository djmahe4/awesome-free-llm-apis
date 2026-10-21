import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { executeSkill } from '../src/tools/execute-skill.js';
import { useFreeLLM } from '../src/tools/use-free-llm.js';
import { loadSkillPrompt } from '../src/tools/load-skill-prompt.js';

vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: vi.fn() }));
vi.mock('../src/tools/load-skill-prompt.js', () => ({
  loadSkillPrompt: vi.fn(async () => ({ success: true, skills: [{ name: 'bug_hunting' }] })),
}));
vi.mock('../src/hermes/loader.js', () => ({
  findHermesSkill: vi.fn(async () => null),
  loadHermesSkillContent: vi.fn(async () => null),
  searchHermesSkills: vi.fn(async () => []),
  listHermesSkills: vi.fn(async () => []),
}));
vi.mock('../src/memory/index.js', () => ({
  memoryManager: {
    getWiki: vi.fn().mockReturnValue({
      search: vi.fn().mockResolvedValue([]),
      write: vi.fn().mockResolvedValue({}),
    }),
  },
}));
vi.mock('../src/cache/workspace.js', () => ({
  WorkspaceScanner: class {
    getWorkspaceHash = vi.fn().mockResolvedValue('test-hash');
  },
}));
const logToolCallMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/utils/ChatLogger.js', () => ({
  logToolCall: (...args: any[]) => logToolCallMock(...args),
}));

describe('execute_skill — repo-style workspace skill (skills/<name>/prompt.md + skill.yaml)', () => {
  let ws: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-skill-ws-'));
    await fs.mkdirs(path.join(ws, 'skills', 'bug_hunting'));
    await fs.writeFile(
      path.join(ws, 'skills', 'bug_hunting', 'prompt.md'),
      'REPO_SKILL_PROMPT_MARKER: run katana crawls against the target before scanning.'
    );
    await fs.writeFile(
      path.join(ws, 'skills', 'bug_hunting', 'skill.yaml'),
      'description: REPO_SKILL_DESCRIPTION_MARKER bug bounty playbook'
    );
    (useFreeLLM as any).mockResolvedValue({
      choices: [{ message: { content: 'executed from repo skill' } }],
    });
  });

  afterEach(async () => {
    await fs.remove(ws);
  });

  it('resolves <workspace_root>/skills/<name>/prompt.md (+ skill.yaml description) instead of falling through to Hermes/configDir download', async () => {
    const result = await executeSkill({
      skill: 'bug_hunting',
      input: 'find bugs in example.com',
      workspace_root: ws,
    });

    expect(result.success).toBe(true);
    expect(useFreeLLM).toHaveBeenCalledTimes(1);
    const systemPrompt = (useFreeLLM as any).mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('REPO_SKILL_PROMPT_MARKER');
    expect(systemPrompt).toContain('REPO_SKILL_DESCRIPTION_MARKER');
    expect(loadSkillPrompt).not.toHaveBeenCalled();
  });

  it('honors an explicit skillDir override relative to the workspace root', async () => {
    await fs.mkdirs(path.join(ws, 'custom', 'my_skill'));
    await fs.writeFile(path.join(ws, 'custom', 'my_skill', 'prompt.md'), 'CUSTOM_SKILL_DIR_MARKER');

    const result = await executeSkill({
      skill: 'my_skill',
      input: 'do the thing',
      workspace_root: ws,
      skillDir: 'custom/my_skill',
    } as any);

    expect(result.success).toBe(true);
    const systemPrompt = (useFreeLLM as any).mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('CUSTOM_SKILL_DIR_MARKER');
  });

  it('rejects a skillDir that escapes the workspace root (traversal guard)', async () => {
    const result = await executeSkill({
      skill: 'bug_hunting',
      input: 'x',
      workspace_root: ws,
      skillDir: '../../outside',
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Security');
    expect(useFreeLLM).not.toHaveBeenCalled();
  });
});
