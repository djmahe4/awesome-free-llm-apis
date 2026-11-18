import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { MemoryAuditor } from '../src/memory/memory-auditor.js';
import { getDiskSymbolDb, closeDiskSymbolDb } from '../src/memory/disk-symbol-db.js';
import { TaskDecomposer } from '../src/memory/task-decomposer.js';
import { auditAndPromoteSafePractices } from '../src/memory/safe-practices.js';
import { manageMemory } from '../src/tools/manage-memory.js';
import { WorkspaceScanner } from '../src/cache/workspace.js';

describe('PR 5: Doc Audit, Mermaid Engine, Safe Practices & Task Decomposition', () => {
  let tmpWs: string;
  let auditor: MemoryAuditor;
  let decomposer: TaskDecomposer;

  beforeAll(async () => {
    tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), 'pr5-audit-ws-'));
    auditor = new MemoryAuditor();
    decomposer = new TaskDecomposer();
  });

  afterAll(async () => {
    closeDiskSymbolDb();
    await fs.rm(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('Safe Practices Promotion in AGENTS.md', () => {
    it('creates or appends safe practices for typescript and general engineering', async () => {
      // Put a mock package.json so typescript is detected
      await fs.writeFile(path.join(tmpWs, 'package.json'), JSON.stringify({ name: 'test-pkg' }), 'utf-8');

      const res = await auditAndPromoteSafePractices(tmpWs);
      expect(res.updated).toBe(true);
      expect(res.languagesDetected).toContain('typescript');
      expect(res.practicesAppended).toContain('typescript');
      expect(res.practicesAppended).toContain('general');

      const agentsContent = await fs.readFile(res.filePath, 'utf-8');
      expect(agentsContent).toContain('## Safe Practices');
      expect(agentsContent).toContain('TypeScript / JavaScript Safe Practices');
      expect(agentsContent).toContain('General Engineering Guidelines');
    });

    it('is idempotent when safe practices are already present', async () => {
      const res = await auditAndPromoteSafePractices(tmpWs);
      expect(res.updated).toBe(false);
      expect(res.practicesAppended.length).toBe(0);
    });
  });

  describe('Documentation & Skill Audit Drift Checks', () => {
    it('detects broken symbol references and skill drift against DiskSymbolDb', async () => {
      const scanner = new WorkspaceScanner();
      const wsHash = await scanner.getWorkspaceHash(tmpWs);
      const diskDb = getDiskSymbolDb();

      // Seed a canonical node in DiskSymbolDb
      diskDb.putNode(wsHash, {
        id: 'fn:auth:login',
        kind: 'function',
        filePath: 'src/auth.ts',
        lineStart: 1,
        lineEnd: 10,
        signature: 'login(user: string, pass: string): boolean',
      });

      // Create a skill markdown referencing both valid and non-existent symbols
      const skillPath = path.join(tmpWs, 'SKILL.md');
      const skillContent = `# Auth Skill\n\nCalls [[login]] and also calls [[nonExistentHelperSymbol]].\n`;
      await fs.writeFile(skillPath, skillContent, 'utf-8');

      const report = await auditor.auditDocumentation({
        workspace_root: tmpWs,
        filePaths: ['SKILL.md'],
        compareGraph: true,
      });

      expect(report.success).toBe(true);
      expect(report.docsAudited).toBe(1);
      // Valid symbol [[login]] matches 'fn:auth:login'; [[nonExistentHelperSymbol]] drifts
      expect(report.docDrift.brokenSymbolReferences.some(b => b.symbol === 'nonExistentHelperSymbol')).toBe(true);
      expect(report.docDrift.skillDrift).toBeDefined();
      expect(report.docDrift.skillDrift!.some(s => s.brokenSymbol === 'nonExistentHelperSymbol')).toBe(true);
      expect(report.safePractices).toBeDefined();
    });
  });

  describe('Task Decomposition with Graph Centrality & Heavy Node Analysis', () => {
    it('identifies heavy nodes with high fan-in in DiskSymbolDb', async () => {
      const scanner = new WorkspaceScanner();
      const wsHash = await scanner.getWorkspaceHash(tmpWs);
      const diskDb = getDiskSymbolDb();

      // Seed a core utility function with multiple callers
      diskDb.putNode(wsHash, {
        id: 'fn:core:executeDispatch',
        kind: 'function',
        filePath: 'src/core/dispatch.ts',
        lineStart: 10,
        lineEnd: 25,
      });

      diskDb.putNode(wsHash, {
        id: 'fn:api:handlePost',
        kind: 'function',
        filePath: 'src/api/handler.ts',
        lineStart: 1,
        lineEnd: 15,
      });

      diskDb.putNode(wsHash, {
        id: 'fn:api:handleGet',
        kind: 'function',
        filePath: 'src/api/handler.ts',
        lineStart: 16,
        lineEnd: 30,
      });

      // Edges: handlePost -> executeDispatch, handleGet -> executeDispatch (fan-in = 2)
      diskDb.putEdge(wsHash, {
        source: 'fn:api:handlePost',
        target: 'fn:core:executeDispatch',
        kind: 'calls',
      });
      diskDb.putEdge(wsHash, {
        source: 'fn:api:handleGet',
        target: 'fn:core:executeDispatch',
        kind: 'calls',
      });

      const heavyNodes = await decomposer.identifyHeavyNodes(tmpWs);
      expect(heavyNodes.length).toBeGreaterThan(0);
      const targetHeavy = heavyNodes.find(h => h.symbol === 'fn:core:executeDispatch');
      expect(targetHeavy).toBeDefined();
      expect(targetHeavy!.fanIn).toBe(2);
      expect(targetHeavy!.riskScore).toBeGreaterThanOrEqual(4);
    });

    it('decomposes a multi-step goal and flags heavy nodes in task contexts', async () => {
      const goal = `Refactor core pipeline:
1. Update src/core/dispatch.ts to add timeout
2. Update src/api/handler.ts to pass timeout options`;

      const plan = await decomposer.decomposeTask({
        goal,
        workspace_root: tmpWs,
        candidateFiles: ['src/core/dispatch.ts', 'src/api/handler.ts'],
      });

      expect(plan.success).toBe(true);
      expect(plan.tasks.length).toBe(2);
      expect(plan.tasks[0].task).toContain('dispatch.ts');
      expect(plan.tasks[0].targetFile).toBe('src/core/dispatch.ts');
      // Subtask touching dispatch.ts should be flagged with caution context
      expect(plan.tasks[0].context).toContain('Caution: Heavy Node');
      expect(plan.suggestedVerification.length).toBeGreaterThan(0);
    });

    it('executes decompose_task through manage_memory tool dispatch', async () => {
      const res = await manageMemory({
        action: 'decompose_task',
        workspace_root: tmpWs,
        task: 'Step 1: Check tests. Step 2: Update docs.',
      });

      expect(res.success).toBe(true);
      expect(res.tasks).toHaveLength(2);
      expect(res.tasks[0].id).toBe('subtask-1');
      expect(res.tasks[1].id).toBe('subtask-2');
    });
  });
});
