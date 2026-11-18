import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { manageMemory } from '../src/tools/manage-memory.js';
import { WorkspaceLockManager } from '../src/memory/workspace-lock.js';

describe('manage_memory: resolve_workspace_lock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-lock-test-'));
    // Setup mock workspace structure
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-project' }), 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Overview\nGetting started guide for users.', 'utf-8');
    const docsDir = path.join(tmpDir, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'mcp-development.md'), '# Developer Manual\nIPC protocols, state machines, and contracts.', 'utf-8');

    // Acquire lock initially
    await WorkspaceLockManager.getInstance().acquireLock(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('analyzes doc schematics, suggests skills, reports local model status, and unlocks workspace', async () => {
    const res: any = await manageMemory({
      action: 'resolve_workspace_lock',
      workspace_root: tmpDir,
    });

    expect(res.success).toBe(true);
    expect(res.locked).toBe(false);
    expect(res.schematics).toBeDefined();
    expect(res.schematics.length).toBeGreaterThanOrEqual(2);

    // Verify audience detection in returned schematics
    const readmeSchematic = res.schematics.find((s: any) => s.filePath.includes('README.md'));
    expect(readmeSchematic?.audience).toBe('public');

    const devSchematic = res.schematics.find((s: any) => s.filePath.includes('mcp-development.md'));
    expect(devSchematic?.audience).toBe('dev');

    // Verify suggested skills include skill-writer
    expect(res.suggestedSkills).toContain('skill-writer');

    // Verify local model advisory is returned when local models are offline/unconfigured
    expect(res.localModelStatus).toBeDefined();
    if (!res.localModelStatus.ready) {
      expect(res.reminder).toContain('manage_memory');
    }

    // Verify workspace is actually unlocked in lock manager
    expect(await WorkspaceLockManager.getInstance().isLocked(tmpDir)).toBe(false);
  });
});
