import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getMcpDir } from '../utils/mcp-home.js';

export interface WorkspaceLockResolution {
  resolvedBy: string;
  docsSchematic?: any[];
  suggestedSkills?: string[];
  resolvedAt?: string;
}

export interface WorkspaceLockState {
  locked: boolean;
  lockId?: string;
  workspaceRoot: string;
  createdAt?: string;
  resolution?: WorkspaceLockResolution;
}

export class WorkspaceLockManager {
  private static instance: WorkspaceLockManager;

  public static getInstance(): WorkspaceLockManager {
    if (!WorkspaceLockManager.instance) {
      WorkspaceLockManager.instance = new WorkspaceLockManager();
    }
    return WorkspaceLockManager.instance;
  }

  private getLockFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.free-llm-mcp', 'workspace.lock');
  }

  public async isLocked(workspaceRoot: string): Promise<boolean> {
    try {
      const lockPath = this.getLockFilePath(workspaceRoot);
      const content = await fs.readFile(lockPath, 'utf-8');
      const parsed: WorkspaceLockState = JSON.parse(content);
      return Boolean(parsed.locked);
    } catch {
      return false;
    }
  }

  public async getLockState(workspaceRoot: string): Promise<WorkspaceLockState | null> {
    try {
      const lockPath = this.getLockFilePath(workspaceRoot);
      const content = await fs.readFile(lockPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  public async acquireLock(workspaceRoot: string): Promise<WorkspaceLockState> {
    const lockDir = path.join(workspaceRoot, '.free-llm-mcp');
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = this.getLockFilePath(workspaceRoot);
    const existing = await this.getLockState(workspaceRoot);
    if (existing && existing.locked) {
      return existing;
    }

    const state: WorkspaceLockState = {
      locked: true,
      lockId: `lock-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      workspaceRoot,
      createdAt: new Date().toISOString(),
    };

    const tmpFile = `${lockPath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmpFile, lockPath);
    return state;
  }

  public async resolveLock(workspaceRoot: string, resolution: WorkspaceLockResolution): Promise<WorkspaceLockState> {
    const lockPath = this.getLockFilePath(workspaceRoot);
    const current = await this.getLockState(workspaceRoot) || {
      locked: false,
      workspaceRoot,
    };

    const state: WorkspaceLockState = {
      ...current,
      locked: false,
      resolution: {
        ...resolution,
        resolvedAt: new Date().toISOString(),
      },
    };

    const tmpFile = `${lockPath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmpFile, lockPath);
    return state;
  }

  /**
   * Preloads skill-writer into the workspace folder so that skill auditing
   * and authoring specifications are immediately available locally offline.
   */
  public async preloadSkillWriter(workspaceRoot: string): Promise<{ success: boolean; skillPath: string }> {
    const targetDir = path.join(workspaceRoot, '.free-llm-mcp', 'skills', 'skill-writer');
    const targetReferencesDir = path.join(targetDir, 'references');
    await fs.mkdir(targetReferencesDir, { recursive: true });

    // Look for canonical skill-writer source
    const candidates = [
      path.join(os.homedir(), '.free-llm-mcp', 'skills', 'skill-writer'),
      path.join(getMcpDir(), 'skills', 'skill-writer'),
      path.join(process.cwd(), '.free-llm-mcp', 'skills', 'skill-writer'),
    ];

    let foundSource: string | null = null;
    for (const cand of candidates) {
      try {
        const stat = await fs.stat(path.join(cand, 'SKILL.md'));
        if (stat.isFile()) {
          foundSource = cand;
          break;
        }
      } catch {}
    }

    if (foundSource) {
      // Copy directory recursively
      await this.copyDirRecursive(foundSource, targetDir);
    } else {
      // Embedded fallback minimal skill-writer
      const defaultSkillMd = `---
name: skill-writer
description: Create and improve agent skills following the Agent Skills specification. Use when asked to create, write, or update skills.
risk: critical
source: local-preload
---

# Skill Writer
Deterministic local skill-writer definition.
## Output format
1. Summary
2. Changes Made
3. Validation Results
4. Open Gaps
`;
      await fs.writeFile(path.join(targetDir, 'SKILL.md'), defaultSkillMd, 'utf-8');
      const authoringPath = path.join(targetReferencesDir, 'authoring-path.md');
      await fs.writeFile(authoringPath, '# Authoring Path\nDeterministic checklist.', 'utf-8');
    }

    return {
      success: true,
      skillPath: path.join(targetDir, 'SKILL.md'),
    };
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}
