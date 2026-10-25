import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/tools/load-skill-prompt.js', () => ({ loadSkillPrompt: vi.fn() }));
vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ran with the skill' } }] }) }));
vi.mock('../src/utils/ChatLogger.js', () => ({ logToolCall: vi.fn().mockResolvedValue(undefined) }));

import { loadSkillPrompt } from '../src/tools/load-skill-prompt.js';
import { executeSkill } from '../src/tools/execute-skill.js';

// S1: when the skill is not on disk, execute_skill asks load_skill_prompt to download it. That download
// runs in the background and answers { status: 'running' } at once; execute_skill then checked for
// SKILL.md immediately, so a first run of any not-yet-downloaded skill always failed.
// S5: the wrapper rethrew although its contract (and its own comment) says it never throws.

let ws = '';
const skillMd = () => path.join(ws, '.free-llm-mcp', 'skills', 'demo', 'SKILL.md');
const load = loadSkillPrompt as unknown as ReturnType<typeof vi.fn>;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-fallback-'));
  await fs.ensureDir(path.join(ws, '.free-llm-mcp'));
  process.env.EXECUTE_SKILL_DOWNLOAD_POLL_MS = '5';
  process.env.EXECUTE_SKILL_DOWNLOAD_TIMEOUT_MS = '400';
  load.mockReset();
});
afterEach(async () => {
  delete process.env.EXECUTE_SKILL_DOWNLOAD_POLL_MS;
  delete process.env.EXECUTE_SKILL_DOWNLOAD_TIMEOUT_MS;
  await fs.remove(ws);
});

const run = () => executeSkill({ skill: 'demo', input: 'go', workspace_root: ws, source: 'agentic-awesome' } as any);

describe('execute_skill download fallback', () => {
  it('waits for the background download instead of failing the first run', async () => {
    let polls = 0;
    load.mockImplementation(async (i: any) => {
      if (i.pollAction === 'status') {
        polls++;
        if (polls < 3) return { success: true, status: 'running', message: 'Downloading 1/2' };
        await fs.outputFile(skillMd(), '# demo skill\nDo the thing.');
        return { success: true, skill: 'demo' };
      }
      return { success: true, status: 'running', sessionId: 'demo' };
    });
    const r = await run();
    expect(r.success).toBe(true);
    expect(polls).toBe(3);
    // the status poll uses the same session the download started with
    expect(load.mock.calls.some(c => c[0].pollAction === 'status' && c[0].name === 'demo')).toBe(true);
  });

  it('an immediately finished download needs no polling', async () => {
    load.mockImplementation(async () => { await fs.outputFile(skillMd(), '# demo'); return { success: true }; });
    const r = await run();
    expect(r.success).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a download that never finishes ends with a clear, retryable error', async () => {
    load.mockResolvedValue({ success: true, status: 'running', message: 'Downloading 1/9' });
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/still downloading/i);
    expect(r.error).toMatch(/try again|retry/i);
  });

  it('a failed download reports its error', async () => {
    load.mockImplementation(async (i: any) => (i.pollAction === 'status' ? { success: false, error: 'GitHub rate limit' } : { success: true, status: 'running' }));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/GitHub rate limit/);
  });
});

describe('execute_skill never throws (S5)', () => {
  it('a throw inside the load path comes back as a failed result', async () => {
    load.mockRejectedValue(new Error('network exploded'));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/network exploded/);
  });
});

describe('execute_skill contract', () => {
  it('an error thrown outside the load path is returned, not rethrown', async () => {
    const input: any = { skill: 'demo', input: 'go', source: 'agentic-awesome' };
    Object.defineProperty(input, 'workspace_root', { get() { throw new Error('unreadable workspace'); } });
    const r = await executeSkill(input);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/unreadable workspace/);
  });
});
