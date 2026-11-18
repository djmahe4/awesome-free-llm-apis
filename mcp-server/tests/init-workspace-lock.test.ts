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

  it('acquires workspace lock, preloads skill-writer, initializes docs-schema, and records documentation maintenance rules', async () => {
    const success = await initWorkspace(tmpDir);
    expect(success).toBe(true);

    // Verify .agents/AGENTS.md has Documentation Maintenance
    const agentsPath = path.join(tmpDir, '.agents', 'AGENTS.md');
    const agentsContent = await fs.readFile(agentsPath, 'utf-8');
    expect(agentsContent).toContain('## Documentation Maintenance');
    expect(agentsContent).toContain('Code-to-Docs Traceability');
    expect(agentsContent).toContain('Architectural Diagrams');

    // Verify workspace lock
    const lockManager = WorkspaceLockManager.getInstance();
    expect(await lockManager.isLocked(tmpDir)).toBe(true);

    // Verify skill-writer preloaded
    const skillWriterPath = path.join(tmpDir, '.free-llm-mcp', 'skills', 'skill-writer', 'SKILL.md');
    const skillContent = await fs.readFile(skillWriterPath, 'utf-8');
    expect(skillContent).toContain('name: skill-writer');

    // Verify docs-schema.yaml initialized
    const schemaPath = path.join(tmpDir, '.free-llm-mcp', 'docs-schema.yaml');
    const schemaExists = await fs.stat(schemaPath).then(() => true).catch(() => false);
    expect(schemaExists).toBe(true);
  });
});
