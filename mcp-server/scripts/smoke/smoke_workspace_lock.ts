import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initWorkspace } from '../../src/tools/init-workspace.js';
import { manageMemory } from '../../src/tools/manage-memory.js';
import { WorkspaceLockManager } from '../../src/memory/workspace-lock.js';

async function main() {
  console.log('=== Smoke Test: Workspace Lock & Skill Orchestration ===\n');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-ws-lock-'));
  try {
    // 1. Setup sample workspace
    console.log('1. Setting up sample workspace...');
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'smoke-pkg', version: '1.0.0' }), 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Overview\nGetting started and user workflow.\n', 'utf-8');
    const docsDir = path.join(tmpDir, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'mcp-development.md'), '# Developer Manual\nIPC protocol handshake and state machine.\n', 'utf-8');

    // 2. Initialize workspace
    console.log('2. Initializing workspace (initWorkspace)...');
    const initRes = await initWorkspace(tmpDir);
    if (!initRes) throw new Error('initWorkspace failed');

    const lockManager = WorkspaceLockManager.getInstance();
    const isLockedInitially = await lockManager.isLocked(tmpDir);
    console.log(`   Lock state after init: locked=${isLockedInitially}`);
    if (!isLockedInitially) throw new Error('Workspace should be locked upon initialization');

    // Check preloaded skill-writer
    const skillPath = path.join(tmpDir, '.free-llm-mcp', 'skills', 'skill-writer', 'SKILL.md');
    const skillExists = await fs.stat(skillPath).then(() => true).catch(() => false);
    console.log(`   skill-writer preloaded: ${skillExists}`);
    if (!skillExists) throw new Error('skill-writer was not preloaded into workspace folder');

    // 3. Resolve workspace lock via manage_memory
    console.log('3. Resolving workspace lock via manage_memory...');
    const resolveRes: any = await manageMemory({
      action: 'resolve_workspace_lock',
      workspace_root: tmpDir,
    });

    console.log(`   Resolve status: success=${resolveRes.success}, locked=${resolveRes.locked}`);
    console.log(`   Docs schematics analyzed: ${resolveRes.schematics?.length}`);
    console.log(`   Suggested skills: ${resolveRes.suggestedSkills?.join(', ')}`);
    console.log(`   Summary: ${resolveRes.summary}`);

    const isLockedAfter = await lockManager.isLocked(tmpDir);
    console.log(`   Lock state after resolution: locked=${isLockedAfter}`);
    if (isLockedAfter) throw new Error('Workspace lock was not released after resolution');

    console.log('\n✓ Smoke Test Passed Successfully!');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
