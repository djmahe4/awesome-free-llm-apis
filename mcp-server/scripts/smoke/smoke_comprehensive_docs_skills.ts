import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryAuditor, matchSkillWriterRules, formatCompactDriftPill } from '../../src/memory/memory-auditor.js';
import { classifyDocAudience, generateDocSchematic, MERMAID_DIAGRAM_TYPES, classifyDiagramIntent } from '../../src/memory/mermaid-classifier.js';
import { initWorkspace } from '../../src/tools/init-workspace.js';
import { manageMemory } from '../../src/tools/manage-memory.js';
import { WorkspaceLockManager } from '../../src/memory/workspace-lock.js';

async function testAll18MermaidDiagramTypes() {
  console.log('\n--- Test 1: Complete Verification of All 18 Mermaid Diagram Types ---');

  const testCases: Array<{ intentText: string; expectedKeyword: string; expectedName: string }> = [
    { intentText: 'algorithm logic decision tree microservice routing', expectedKeyword: 'flowchart', expectedName: 'Flowchart' },
    { intentText: 'REST gRPC API lifecycle OAuth authentication handshake', expectedKeyword: 'sequenceDiagram', expectedName: 'Sequence Diagram' },
    { intentText: 'object oriented domain models interface inheritance type hierarchy', expectedKeyword: 'classDiagram', expectedName: 'Class Diagram' },
    { intentText: 'relational database schema SQL tables primary foreign keys cardinality', expectedKeyword: 'erDiagram', expectedName: 'Entity Relationship (ERD)' },
    { intentText: 'finite state machine FSM order job lifecycle websocket state transitions', expectedKeyword: 'stateDiagram-v2', expectedName: 'State Diagram' },
    { intentText: 'system context C4 containers and component deployment', expectedKeyword: 'C4Context', expectedName: 'C4 Architecture' },
    { intentText: 'cloud infrastructure topologies VPC subnet directional network edges', expectedKeyword: 'architecture-beta', expectedName: 'Architecture' },
    { intentText: 'git branching strategies release tagging merge cherry-pick', expectedKeyword: 'gitGraph', expectedName: 'Git Graph' },
    { intentText: 'sprint roadmap release milestones task schedule critical path', expectedKeyword: 'gantt', expectedName: 'Gantt Chart' },
    { intentText: 'end-to-end UX flow user journey onboarding friction scores', expectedKeyword: 'journey', expectedName: 'User Journey' },
    { intentText: 'system decomposition feature brainstorming threat modeling tree mindmap', expectedKeyword: 'mindmap', expectedName: 'Mindmap' },
    { intentText: 'SysML traceability linking functional and security requirements to test cases', expectedKeyword: 'requirementDiagram', expectedName: 'Requirement Diagram' },
    { intentText: 'bit-level network protocol headers TCP IPv4 custom binary frames', expectedKeyword: 'packet-beta', expectedName: 'Packet Diagram' },
    { intentText: 'grid-aligned hardware and software block layouts', expectedKeyword: 'block-beta', expectedName: 'Block Diagram' },
    { intentText: 'benchmarking metrics latency distributions numerical bar or line series', expectedKeyword: 'xychart-beta', expectedName: 'XY Chart' },
    { intentText: 'two axes technical debt prioritization quadrant risk matrices', expectedKeyword: 'quadrantChart', expectedName: 'Quadrant Chart' },
    { intentText: 'chronological events release history incident postmortem timeline', expectedKeyword: 'timeline', expectedName: 'Timeline' },
    { intentText: 'task board work-in-progress WIP limits team workflow kanban cards', expectedKeyword: 'kanban', expectedName: 'Kanban' },
  ];

  expect(Object.keys(MERMAID_DIAGRAM_TYPES).length).toBe(18);

  for (const tc of testCases) {
    const identified = classifyDiagramIntent(tc.intentText);
    if (identified.keyword !== tc.expectedKeyword) {
      throw new Error(`Expected ${tc.expectedKeyword} for "${tc.intentText}", got ${identified.keyword}`);
    }
    console.log(`  ✓ Diagram verified: ${tc.expectedName.padEnd(25)} [${identified.keyword}]`);
  }
}

async function testSkillReferenceChangeRecommendations() {
  console.log('\n--- Test 2: Skill Reference Change Recommendations & skill-writer Matching ---');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-skill-refs-'));
  try {
    const auditor = new MemoryAuditor();

    // 1. Skill with broken/stale symbol references
    const skillWithReferences = `---
name: custom-agent-skill
description: Agent skill for invoking execute_skill and run_transaction
---

# Custom Agent Skill
Calls \`[[nonExistentSymbol]]\` and references \`[[oldFunctionRef]]\`.

## When to Use
Use when executing transactions.

## Limitations
None.

## Output format
1. Summary
2. Changes Made
3. Validation Results
4. Open Gaps
`;
    const skillPath = path.join(tmpDir, 'SKILL.md');
    await fs.writeFile(skillPath, skillWithReferences);

    const docReport = await auditor.auditDocumentation({
      workspace_root: tmpDir,
      filePaths: ['SKILL.md'],
      compareGraph: true,
    });

    console.log(`  Broken symbol references detected: ${docReport.docDrift.brokenSymbolReferences.length}`);
    console.log(`  Skill drift references detected: ${docReport.docDrift.skillDrift?.length || 0}`);

    // 2. Deterministic matching for skill-writer rules
    const match = matchSkillWriterRules(skillWithReferences, ['execute_skill', 'manage_memory']);
    console.log(`  skill-writer compliance: ${match.compliant}`);
    console.log(`  Missing tool keywords: ${match.missingKeywords.join(', ')}`);

    // 3. Remediation fallback test (handling skills with frontmatter but missing sections)
    const partialSkill = `---
name: partial-skill
description: Test skill
---
# Partial Skill
`;
    const rem = await auditor.applySkillDriftRemediation({
      skillContent: partialSkill,
      driftReason: 'Missing Output format contract',
      forceDeterministic: true,
    });
    console.log(`  Remediation type: ${rem.remediationType}`);
    if (!rem.patchedContent.includes('## Output format')) {
      throw new Error('Remediation did not append missing ## Output format section');
    }
    console.log('  ✓ Deterministic skill-writer remediation appended missing sections properly');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testMangledWorkspaceDocsAndOfflineHypothesis() {
  console.log('\n--- Test 3: Mangled Workspace Docs, Rule Extraction & Offline Hypothesis Loop ---');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-mangled-docs-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'mangled-workspace' }));

    // Mangled docs in different folders
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# App\nInstall instructions and user journey onboarding.');
    const docsDir = path.join(tmpDir, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'architecture.md'), '# Architecture\nCloud infrastructure, VPC subnets, and packet routing.');
    await fs.writeFile(path.join(docsDir, 'kanban-roadmap.md'), '# Planning\nSprint roadmap, milestones, and task board with WIP limits.');

    // Code with missing contracts
    const codeDir = path.join(tmpDir, 'src');
    await fs.mkdir(codeDir, { recursive: true });
    await fs.writeFile(path.join(codeDir, 'auth.ts'), `
export function authenticateUser(token: string): boolean {
  return token.length > 10;
}
`);

    const auditor = new MemoryAuditor();

    // Run file audit (Rule-based extraction & contract checks)
    const fileReport = await auditor.auditFile({
      workspace_root: tmpDir,
      filePaths: ['src/auth.ts'],
      compareGraph: false,
    });
    console.log(`  Files audited: ${fileReport.filesAudited}`);
    console.log(`  Missing contracts: ${fileReport.commentAudit.missingContracts.map(c => c.symbol).join(', ')}`);
    console.log(`  Suggested actions: ${fileReport.suggestedActions.map(a => a.action).join(', ')}`);

    // Run doc audit with hypothesize loop
    const docReport = await auditor.auditDocumentation({
      workspace_root: tmpDir,
      filePaths: ['README.md', 'docs/architecture.md', 'docs/kanban-roadmap.md'],
      hypothesize: true,
    });
    console.log(`  Docs audited: ${docReport.docsAudited}`);
    console.log(`  Missing architecture docs: ${docReport.docDrift.missingArchitectureDocs.length}`);
    for (const d of docReport.docDrift.missingArchitectureDocs) {
      console.log(`    - ${d.module}: ${d.suggestedDiagram}`);
    }

    // Resolve workspace lock
    await initWorkspace(tmpDir);
    const resolveRes: any = await manageMemory({
      action: 'resolve_workspace_lock',
      workspace_root: tmpDir,
    });
    console.log(`  Workspace lock resolved: ${!resolveRes.locked}`);
    console.log(`  Schematics produced: ${resolveRes.schematics.length}`);
    console.log(`  Local model status: ready=${resolveRes.localModelStatus?.ready}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function expect(val: any) {
  return {
    toBe: (expected: any) => {
      if (val !== expected) throw new Error(`Expected ${expected}, received ${val}`);
    }
  };
}

async function main() {
  console.log('======================================================================');
  console.log('   COMPREHENSIVE MULTI-SMOKE: ALL 18 DIAGRAMS, SKILLS & DOC AUDIT    ');
  console.log('======================================================================');
  await testAll18MermaidDiagramTypes();
  await testSkillReferenceChangeRecommendations();
  await testMangledWorkspaceDocsAndOfflineHypothesis();
  console.log('\n======================================================================');
  console.log('                  ALL COMPREHENSIVE SMOKES PASSED!                    ');
  console.log('======================================================================');
}

main().catch(err => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
