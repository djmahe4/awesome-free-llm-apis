import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceLockManager } from '../src/memory/workspace-lock.js';

describe('WorkspaceLockManager & skill-writer Preloading', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-lock-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires and checks workspace lock state', async () => {
    const manager = WorkspaceLockManager.getInstance();
    expect(await manager.isLocked(tmpDir)).toBe(false);

    const lockState = await manager.acquireLock(tmpDir);
    expect(lockState.locked).toBe(true);
    expect(lockState.lockId).toBeDefined();
    expect(await manager.isLocked(tmpDir)).toBe(true);
  });

  it('preloads skill-writer into the workspace folder with reference files', async () => {
    const manager = WorkspaceLockManager.getInstance();
    const result = await manager.preloadSkillWriter(tmpDir);
    expect(result.success).toBe(true);

    const skillPath = path.join(tmpDir, '.free-llm-mcp', 'skills', 'skill-writer', 'SKILL.md');
    const skillContent = await fs.readFile(skillPath, 'utf-8');
    expect(skillContent).toContain('name: skill-writer');

    const authoringPath = path.join(tmpDir, '.free-llm-mcp', 'skills', 'skill-writer', 'references', 'authoring-path.md');
    expect(await fs.stat(authoringPath)).toBeDefined();
  });

  it('resolves the workspace lock cleanly', async () => {
    const manager = WorkspaceLockManager.getInstance();
    await manager.acquireLock(tmpDir);
    expect(await manager.isLocked(tmpDir)).toBe(true);

    const resolved = await manager.resolveLock(tmpDir, {
      resolvedBy: 'test-suite',
      docsSchematic: [{ filePath: 'README.md', audience: 'public', summary: 'ok' }],
      suggestedSkills: ['skill-writer'],
    });

    expect(resolved.locked).toBe(false);
    expect(await manager.isLocked(tmpDir)).toBe(false);
    expect(resolved.resolution?.suggestedSkills).toContain('skill-writer');
  });
});
