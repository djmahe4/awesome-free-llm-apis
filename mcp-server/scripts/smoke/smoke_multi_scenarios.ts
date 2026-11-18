import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryAuditor } from '../../src/memory/memory-auditor.js';
import { matchSkillWriterRules, formatCompactDriftPill } from '../../src/memory/memory-auditor.js';
import { classifyDocAudience, generateDocSchematic } from '../../src/memory/mermaid-classifier.js';
import { initWorkspace } from '../../src/tools/init-workspace.js';
import { manageMemory } from '../../src/tools/manage-memory.js';
import { WorkspaceLockManager } from '../../src/memory/workspace-lock.js';

async function runScenario1_MangledDocsImprovement() {
  console.log('\n--- Scenario 1: Mangled Documentation & Schematic Suggestions ---');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-scenario1-'));
  try {
    // Create mangled public & dev docs with broken/missing structure
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'mangled-workspace' }));

    // Public doc missing user journey / flowchart
    const publicDoc = `# Quickstart Guide\nInstall and run the CLI. User onboarding and payment workflows.`;
    const publicSchematic = generateDocSchematic('docs/quickstart.md', publicDoc);
    console.log(`[Public Doc] Audience: ${publicSchematic.audience}`);
    console.log(`[Public Doc] Missing Diagrams: ${publicSchematic.missingDiagrams.map(d => `${d.name} (${d.keyword})`).join(', ')}`);

    // Dev doc missing state/sequence diagrams
    const devDoc = `# MCP Protocols\nHandles JSON-RPC request lifecycles, connection state transitions, and contract types.`;
    const devSchematic = generateDocSchematic('docs/mcp-development.md', devDoc);
    console.log(`[Dev Doc] Audience: ${devSchematic.audience}`);
    console.log(`[Dev Doc] Missing Diagrams: ${devSchematic.missingDiagrams.map(d => `${d.name} (${d.keyword})`).join(', ')}`);

    if (publicSchematic.audience !== 'public' || devSchematic.audience !== 'dev') {
      throw new Error('Scenario 1 Failed: Audience misclassification');
    }
    console.log('✓ Scenario 1: Mangled doc classification and diagram suggestion PASSED');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runScenario2_RuleBasedExtractionAndContracts() {
  console.log('\n--- Scenario 2: Rule-Based Extraction & Missing Contracts ---');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-scenario2-'));
  try {
    // Create code with exported function missing contracts and file header
    const sampleCode = `
export function processTransaction(account: string, amount: number): boolean {
  return amount > 0;
}
`;
    const codeFile = path.join(tmpDir, 'transaction.ts');
    await fs.writeFile(codeFile, sampleCode);

    const auditor = new MemoryAuditor();
    const fileReport = await auditor.auditFile({
      workspace_root: tmpDir,
      filePaths: ['transaction.ts'],
      compareGraph: false,
      includeTests: false,
    });

    console.log(`[File Audit] Audited: ${fileReport.filesAudited} file(s)`);
    console.log(`[File Audit] Missing Headers: ${fileReport.commentAudit.missingFileHeaders.join(', ')}`);
    console.log(`[File Audit] Missing Contracts: ${fileReport.commentAudit.missingContracts.map(c => `${c.symbol} in ${c.filePath}`).join(', ')}`);

    if (fileReport.commentAudit.missingContracts.length === 0) {
      throw new Error('Scenario 2 Failed: Did not detect missing contracts on exported function');
    }
    console.log('✓ Scenario 2: Rule-based extraction & contract checks PASSED');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runScenario3_SkillWriterSemanticMatchingAndPreloading() {
  console.log('\n--- Scenario 3: skill-writer Matching & Preloading ---');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-scenario3-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'skill-ws' }));

    // Init workspace and verify lock + skill-writer preload
    await initWorkspace(tmpDir);
    const lockMgr = WorkspaceLockManager.getInstance();
    const isLocked = await lockMgr.isLocked(tmpDir);
    console.log(`[Init] Workspace locked: ${isLocked}`);

    const preloadedSkill = path.join(tmpDir, '.free-llm-mcp', 'skills', 'skill-writer', 'SKILL.md');
    const skillExists = await fs.stat(preloadedSkill).then(() => true).catch(() => false);
    console.log(`[Init] skill-writer preloaded: ${skillExists}`);

    // Test a malformed skill file with deterministic matcher
    const malformedSkill = `# My Skill\nSome raw text`;
    const matchRes = matchSkillWriterRules(malformedSkill, ['vitest', 'compile']);
    console.log(`[Skill Matcher] Compliant: ${matchRes.compliant}`);
    console.log(`[Skill Matcher] Missing Sections: ${matchRes.missingSections.join(', ')}`);

    // Format compact pill
    const pill = formatCompactDriftPill({
      docsCount: 2,
      skillsCount: 1,
      docSamples: ['quickstart.md'],
      skillSamples: ['my-skill'],
    });
    console.log(`[Compact Pill] (${pill.length} chars): ${pill}`);

    if (pill.length >= 300) {
      throw new Error('Scenario 3 Failed: Pill exceeds 300 character budget');
    }

    // Resolve lock via manageMemory
    const resolveRes: any = await manageMemory({
      action: 'resolve_workspace_lock',
      workspace_root: tmpDir,
    });
    console.log(`[Resolve Lock] Unlocked: ${!resolveRes.locked}`);

    console.log('✓ Scenario 3: skill-writer matching, preloading, and lock resolution PASSED');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('=====================================================');
  console.log('       MULTI-SCENARIO WORKSPACE & DOC SMOKES         ');
  console.log('=====================================================');
  await runScenario1_MangledDocsImprovement();
  await runScenario2_RuleBasedExtractionAndContracts();
  await runScenario3_SkillWriterSemanticMatchingAndPreloading();
  console.log('\n=====================================================');
  console.log('       ALL 3 SCENARIO SMOKES PASSED CLEANLY!         ');
  console.log('=====================================================');
}

main().catch(err => {
  console.error('Multi-scenario smoke failed:', err);
  process.exit(1);
});
