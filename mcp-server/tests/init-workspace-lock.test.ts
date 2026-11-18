import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initWorkspace } from '../src/tools/init-workspace.js';
import { WorkspaceLockManager } from '../src/memory/workspace-lock.js';

describe('initWorkspace with Workspace Lock & skill-writer Preloading', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'init-ws-lock-test-'));
    // Create mock package.json so it's a valid workspace
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-ws' }), 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires workspace lock and preloads skill-writer during initWorkspace', async () => {
    const success = await initWorkspace(tmpDir);
    expect(success).toBe(true);

    const lockManager = WorkspaceLockManager.getInstance();
    expect(await lockManager.isLocked(tmpDir)).toBe(true);

    const skillWriterPath = path.join(tmpDir, '.free-llm-mcp', 'skills', 'skill-writer', 'SKILL.md');
    const skillContent = await fs.readFile(skillWriterPath, 'utf-8');
    expect(skillContent).toContain('name: skill-writer');
  });
});
