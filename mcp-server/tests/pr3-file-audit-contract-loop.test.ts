import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { MemoryAuditor } from '../src/memory/memory-auditor.js';
import { getDiskSymbolDb, closeDiskSymbolDb } from '../src/memory/disk-symbol-db.js';
import { extractMermaidBlocks, classifyDiagramIntent } from '../src/memory/mermaid-classifier.js';

describe('PR 3: File & Documentation Audit with Mermaid Classifier', () => {
  let tmpWs: string;
  let auditor: MemoryAuditor;

  beforeAll(async () => {
    tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), 'pr3-audit-ws-'));
    auditor = new MemoryAuditor();
  });

  afterAll(async () => {
    closeDiskSymbolDb();
    await fs.rm(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('classifies Mermaid diagram intents accurately from text descriptions', () => {
    expect(classifyDiagramIntent('We need an order status transition and lifecycle machine').keyword).toBe('stateDiagram-v2');
    expect(classifyDiagramIntent('API authentication handshake and OAuth message sequence').keyword).toBe('sequenceDiagram');
    expect(classifyDiagramIntent('User journey and onboarding experience steps').keyword).toBe('journey');
    expect(classifyDiagramIntent('Relational schema with primary and foreign keys').keyword).toBe('erDiagram');
    expect(classifyDiagramIntent('Sprint task board with WIP limits').keyword).toBe('kanban');
  });

  it('extracts and parses Mermaid blocks from markdown documents', () => {
    const doc = `
# Architecture Document

Here is our state lifecycle:
\`\`\`mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Processing
  Processing --> [*]
\`\`\`

And our workflow:
\`\`\`mermaid
flowchart TD
  A[Start] --> B[End]
\`\`\`
    `;

    const blocks = extractMermaidBlocks(doc);
    expect(blocks.length).toBe(2);
    expect(blocks[0].detectedKeyword).toBe('stateDiagram-v2');
    expect(blocks[0].diagramName).toBe('State Diagram');
    expect(blocks[1].detectedKeyword).toBe('flowchart');
    expect(blocks[1].diagramName).toBe('Flowchart');
  });

  it('audits source file for missing contract tags and reports drift', async () => {
    const srcFile = path.join(tmpWs, 'auth-service.ts');
    const content = `/* Authentication module header */
export function login(user: string, pass: string): boolean {
  return true;
}

export function refreshToken(token: string): string {
  return token;
}
`;
    await fs.writeFile(srcFile, content, 'utf-8');

    const result = await auditor.auditFile({
      workspace_root: tmpWs,
      filePaths: ['auth-service.ts'],
      compareGraph: false,
    });

    expect(result.success).toBe(true);
    expect(result.filesAudited).toBe(1);
    expect(result.commentAudit.missingFileHeaders.length).toBe(0); // Header exists
    expect(result.commentAudit.missingContracts.length).toBeGreaterThan(0);
    expect(result.commentAudit.missingContracts.some(c => c.symbol === 'login')).toBe(true);
  });

  it('audits documentation for missing architectural diagrams', async () => {
    const docFile = path.join(tmpWs, 'pipeline-architecture.md');
    const content = `# Pipeline Architecture\n\nThis document describes the workflow lifecycle and data pipeline routing.`;
    await fs.writeFile(docFile, content, 'utf-8');

    const result = await auditor.auditDocumentation({
      workspace_root: tmpWs,
      filePaths: ['pipeline-architecture.md'],
      compareGraph: false,
    });

    expect(result.success).toBe(true);
    expect(result.docsAudited).toBe(1);
    expect(result.docDrift.missingArchitectureDocs.length).toBe(1);
    expect(result.docDrift.missingArchitectureDocs[0].module).toBe('pipeline-architecture.md');
    expect(result.suggestedActions.some(a => a.action === 'wiki_write')).toBe(true);
  });
});
