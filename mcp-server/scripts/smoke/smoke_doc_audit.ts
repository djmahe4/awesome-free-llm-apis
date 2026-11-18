/**
 * Smoke script: runs live MemoryAuditor (file audit and documentation audit)
 * on the real workspace to detect documentation drift, broken references,
 * missing diagrams, and verify the memory promotion feedback loop.
 */
import path from 'node:path';
import { MemoryAuditor } from '../../src/memory/memory-auditor.js';
import { WorkspaceScanner } from '../../src/cache/workspace.js';

async function main() {
  console.log('=== Starting Documentation & File Memory Audit Smoke ===\n');

  const workspaceRoot = path.resolve(process.cwd());
  const auditor = new MemoryAuditor();
  const scanner = new WorkspaceScanner(process.cwd());
  const hash = await scanner.getWorkspaceHash(workspaceRoot);
  console.log(`[Workspace] ${workspaceRoot} (hash: ${hash.substring(0, 12)}...)`);

  // 1. Audit core documentation files
  console.log('\n--- 1. Auditing Core Architecture & Guidance Docs ---');
  const docFiles = [
    'README.md',
    '../GEMINI.md',
    '../docs/skill/SKILL.md',
  ];

  const docReport = await auditor.auditDocumentation({
    workspace_root: workspaceRoot,
    filePaths: docFiles,
    includeTests: false,
    compareGraph: true,
    hypothesize: true,
  });

  console.log(`Docs Audited: ${docReport.docsAudited}`);
  console.log(`Diagrams Found: ${docReport.diagramAudit.length}`);
  for (const diag of docReport.diagramAudit) {
    console.log(`  ✓ ${diag.filePath}:${diag.line} -> ${diag.diagramName || diag.detectedKeyword || 'diagram'}`);
  }

  console.log(`Missing Architecture Docs: ${docReport.docDrift.missingArchitectureDocs.length}`);
  for (const miss of docReport.docDrift.missingArchitectureDocs) {
    console.log(`  ⚠ ${miss.module} -> suggested: ${miss.suggestedDiagram}`);
  }

  console.log(`Broken Symbol References: ${docReport.docDrift.brokenSymbolReferences.length}`);
  for (const brk of docReport.docDrift.brokenSymbolReferences) {
    console.log(`  ✖ [[${brk.symbol}]] in ${brk.filePath}`);
  }

  if (docReport.hypothesis) {
    console.log(`\nHypothesis: ${docReport.hypothesis.summary} (confidence: ${docReport.hypothesis.confidence})`);
  }

  // 2. Audit selected source files for contract/comment completeness
  console.log('\n--- 2. Auditing Core Memory Files for Contract Completeness ---');
  const codeFiles = [
    'src/memory/dag.ts',
    'src/memory/wiki.ts',
    'src/memory/task-decomposer.ts',
    'src/memory/memory-auditor.ts',
  ];

  const fileReport = await auditor.auditFile({
    workspace_root: workspaceRoot,
    filePaths: codeFiles,
    includeTests: false,
    compareGraph: true,
    hypothesize: false,
  });

  console.log(`Files Audited: ${fileReport.filesAudited}`);
  console.log(`Missing File Headers: ${fileReport.commentAudit.missingFileHeaders.length}`);
  console.log(`Missing Function Headers: ${fileReport.commentAudit.missingFunctionHeaders.length}`);
  console.log(`Missing Contracts: ${fileReport.commentAudit.missingContracts.length}`);
  console.log(`Stale Comments: ${fileReport.commentAudit.staleComments.length}`);

  if (fileReport.commentAudit.counts) {
    console.log(`Comment Counts: ${JSON.stringify(fileReport.commentAudit.counts)}`);
  }

  console.log('\n=== Smoke Verification Summary ===');
  console.log(`Doc Audit Success: ${docReport.success ? 'PASS' : 'FAIL'}`);
  console.log(`File Audit Success: ${fileReport.success ? 'PASS' : 'FAIL'}`);

  if (!docReport.success || !fileReport.success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
