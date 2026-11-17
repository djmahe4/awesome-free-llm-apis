import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiskSymbolDb } from '../src/memory/disk-symbol-db.js';
import { KnowledgeRuleLoader } from '../src/memory/knowledge-builder.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('PR 2: Unified Knowledge Store & Multi-Language Engine', () => {
  let db: DiskSymbolDb;
  let tmpDir: string;
  const repoHash = 'test-repo-hash';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-kb-test-'));
    db = new DiskSymbolDb({ baseDir: tmpDir });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Unified DiskSymbolDb Views', () => {
    it('populates nodes and cleanly filters code vs wiki vs blackboard views', () => {
      // 1. Code symbol
      db.putNode(repoHash, {
        id: 'src/auth.ts#login',
        kind: 'function',
        filePath: 'src/auth.ts',
        signature: '(user, pass)',
      });

      // 2. Wiki/Doc concept
      db.putNode(repoHash, {
        id: 'wiki:auth_design',
        kind: 'concept',
        filePath: 'docs/auth.md',
      });

      // 3. Blackboard node
      db.putNode(repoHash, {
        id: 'bb:screenshot-1',
        kind: 'blackboard',
        filePath: 'screenshots/shot.png',
      });

      // Edges
      db.putEdge(repoHash, {
        source: 'wiki:auth_design',
        target: 'src/auth.ts#login',
        kind: 'references',
      });

      const codeView = db.getCodeGraph(repoHash);
      expect(codeView.nodes.length).toBe(1);
      expect(codeView.nodes[0].id).toBe('src/auth.ts#login');

      const wikiView = db.getWikiView(repoHash);
      expect(wikiView.nodes.length).toBe(1);
      expect(wikiView.nodes[0].id).toBe('wiki:auth_design');
      expect(wikiView.edges.length).toBe(1);

      const bbView = db.getBlackboardView(repoHash);
      expect(bbView.nodes.length).toBe(1);
      expect(bbView.nodes[0].id).toBe('bb:screenshot-1');
    });
  });

  describe('KnowledgeRuleLoader Multi-Language AST Extraction', () => {
    it('extracts TypeScript functions with inline contracts', () => {
      const loader = KnowledgeRuleLoader.getInstance();
      const tsCode = `
/**
 * @contract Validates user credentials
 * @throws {AuthError} If credentials invalid
 */
export async function authenticateUser(username: string, pass: string): Promise<User> {
  return null as any;
}
`;
      const nodes = loader.extractNodesFromFile('src/auth.ts', tsCode);
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('authenticateUser');
      expect(nodes[0].kind).toBe('function');
      expect(nodes[0].contracts).toBeDefined();
      expect(nodes[0].contracts?.some(c => c.includes('@contract'))).toBe(true);
      expect(nodes[0].contracts?.some(c => c.includes('@throws'))).toBe(true);
    });

    it('extracts Python function definitions with decorators and return types', () => {
      const loader = KnowledgeRuleLoader.getInstance();
      const pyCode = `
# @contract computes hash
@lru_cache(maxsize=128)
@retry
def calculate_hash(data: str, salt: str) -> str:
    pass
`;
      const nodes = loader.extractNodesFromFile('services/hash.py', pyCode);
      const fnNode = nodes.find(n => n.kind === 'function');
      expect(fnNode).toBeDefined();
      expect(fnNode?.name).toBe('calculate_hash');
      expect(fnNode?.language.toLowerCase()).toBe('python');
      expect(fnNode?.decorators).toBeDefined();
      expect(fnNode?.decorators?.some(d => d.includes('@lru_cache'))).toBe(true);
      expect(fnNode?.decorators?.some(d => d.includes('@retry'))).toBe(true);
      expect(fnNode?.contracts?.some(c => c.includes('@contract'))).toBe(true);
    });

    it('extracts Python constants and environment variables', () => {
      const loader = KnowledgeRuleLoader.getInstance();
      const pyCode = `
MAX_RETRIES = 5
API_KEY = os.getenv("SECRET_KEY")
DATABASE_URL = os.environ.get("DATABASE_URL")
`;
      const nodes = loader.extractNodesFromFile('config/settings.py', pyCode);
      const constNode = nodes.find(n => n.name === 'MAX_RETRIES');
      expect(constNode).toBeDefined();
      expect(constNode?.kind).toBe('constant');

      const envNodes = nodes.filter(n => n.kind === 'env_var');
      expect(envNodes.some(e => e.name === 'SECRET_KEY')).toBe(true);
      expect(envNodes.some(e => e.name === 'DATABASE_URL')).toBe(true);
    });

    it('correctly detects test files for exclusion', () => {
      const loader = KnowledgeRuleLoader.getInstance();
      expect(loader.isTestFile('src/__tests__/auth.test.ts')).toBe(true);
      expect(loader.isTestFile('src/auth.spec.ts')).toBe(true);
      expect(loader.isTestFile('tests/unit/test_app.py')).toBe(true);
      expect(loader.isTestFile('src/components/Header.tsx')).toBe(false);
    });
  });
});
