import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getMcpDir } from '../utils/mcp-home.js';
import { DocsSchemaManager, type DocsSchema } from './docs-schema-manager.js';

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
   * Ensures that an existing workspace has its repository context and docs-schema.yaml recorded.
   * If not yet extracted, triggers the workspace lock, preloads skill-writer, and uses the local
   * model to suggest the preferred code-to-docs mapping in .yaml.
   * Does NOT fail tools: returns a paused status with resumable context.
   */
  public async ensureWorkspaceContext(
    workspaceRoot: string,
    options?: { allowLocalModel?: boolean; autoResolve?: boolean }
  ): Promise<{
    locked: boolean;
    paused: boolean;
    schema: DocsSchema | null;
    lockState: WorkspaceLockState;
    message: string;
  }> {
    const schemaManager = DocsSchemaManager.getInstance();
    let schema = await schemaManager.loadSchema(workspaceRoot);

    if (!schema) {
      // 1. Acquire workspace lock because repo context / docs schema not yet extracted
      const lockState = await this.acquireLock(workspaceRoot);

      // 2. Preload skill-writer locally
      await this.preloadSkillWriter(workspaceRoot);

      // 3. Generate suggested schema from local model / workspace scanner
      schema = await schemaManager.generateSuggestedSchema(workspaceRoot, options?.allowLocalModel ?? true);

      if (options?.autoResolve) {
        // Save schema to .yaml
        await schemaManager.saveSchema(workspaceRoot, schema);
        // Clear/resolve lock
        const resolvedLock = await this.resolveLock(workspaceRoot, {
          resolvedBy: 'auto_schema_init',
          docsSchematic: schema.codeDocsMapping,
          suggestedSkills: ['skill-writer'],
        });
        return {
          locked: false,
          paused: false,
          schema,
          lockState: resolvedLock,
          message: 'Workspace context and docs-schema.yaml initialized successfully. Lock cleared.',
        };
      } else {
        // Report paused state rather than failing
        return {
          locked: true,
          paused: true,
          schema,
          lockState,
          message: 'Workspace lock active: docs-schema.yaml and repo context required. Call resolve_workspace_lock to confirm and continue.',
        };
      }
    }

    const currentLock = await this.getLockState(workspaceRoot);
    const isCurrentlyLocked = Boolean(currentLock?.locked);
    return {
      locked: isCurrentlyLocked,
      paused: isCurrentlyLocked,
      schema,
      lockState: currentLock || { locked: false, workspaceRoot },
      message: isCurrentlyLocked ? 'Workspace is currently locked.' : 'Workspace context active.',
    };
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
