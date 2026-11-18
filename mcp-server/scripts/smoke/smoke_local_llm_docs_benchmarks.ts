import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryAuditor } from '../../src/memory/memory-auditor.js';
import { extractDynamicWorkspaceContext } from '../../src/memory/workspace-context.js';

async function main() {
  console.log('=== Smoke TDD: Live Local LLM Docs & Skill Recommendations (Dynamic Workspace Grounding) ===\n');

  const benchmarkDir = path.join(process.cwd(), '..', 'benchmarks');
  await fs.mkdir(benchmarkDir, { recursive: true });
  const benchmarkFile = path.join(benchmarkDir, '2026-11-18-docs-skill-local-llm-smoke.md');

  // Verify dynamic workspace extraction on current repository
  console.log('0. Testing dynamic context extraction on current repository...');
  const repoRoot = path.resolve(process.cwd(), '..');
  const repoWsContext = await extractDynamicWorkspaceContext(repoRoot);
  console.log('   Derived Name:', repoWsContext.name);
  console.log('   Derived Description:', repoWsContext.description);
  console.log('   Key Components:', repoWsContext.keyComponents.slice(0, 8).join(', '));
  console.log('   Context Summary:', repoWsContext.contextSummary);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-dynamic-ws-'));

  const benchmarkLines: string[] = [
    '# Local LLM Docs & Skill Drift Recommendations Benchmark',
    '',
    `**Date:** ${new Date().toISOString()}`,
    '**Runtime Environment:** Node.js + Ollama (Local Model Acceleration)',
    `**Grounding Verification:** Dynamic Multi-Workspace Extraction (Zero Hardcoded Paths/Names)`,
    '',
    '## Executive Summary',
    'Demonstrates smoke-test-driven verification of local model synthesis for architectural diagrams and agent skill drift remediation across arbitrary workspaces. All prompts dynamically extract the target workspace name, manifest metadata, and active tools rather than assuming hardcoded repository names.',
    '',
    '---',
    '',
    '## Workspace Context Dynamic Extraction Verification',
    `- **Host Repository Workspace:** \`${repoWsContext.name}\``,
    `- **Auto-Derived Description:** ${repoWsContext.description}`,
    `- **Discovered Components/Modules:** ${repoWsContext.keyComponents.slice(0, 10).join(', ')}`,
    '',
    '---',
    '',
  ];

  try {
    // Setup a realistic foreign workspace to verify universality
    const customPkg = {
      name: '@acme/payment-routing-mesh',
      description: 'Distributed payment router and settlement ledger with Stripe, Adyen, and Redis cache',
      dependencies: {
        stripe: '^14.0.0',
        ioredis: '^5.3.0',
        fastify: '^4.26.0',
      },
    };
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(customPkg, null, 2));

    const auditor = new MemoryAuditor();

    // 1. Mangled Documentation Analysis & Local LLM Mermaid Diagram Synthesis
    console.log('\n1. Auditing mangled documentation in foreign workspace with local LLM hypothesis loop...');
    const mangledDoc = `# Payment Gateway Routing & Settlement Lifecycle
The payment router exposes high-throughput endpoints for transaction checkout.
Incoming payment intents hit Fastify API Gateway, which queries Redis for idempotency keys.
PaymentRouter dispatches settlement requests to Stripe or Adyen provider based on card bin.
Upon webhook confirmation, the settlement ledger records the finalized balance.
`;
    const docPath = path.join(tmpDir, 'payment-routing.md');
    await fs.writeFile(docPath, mangledDoc);

    const docStartTime = Date.now();
    const docReport = await auditor.auditDocumentation({
      workspace_root: tmpDir,
      filePaths: ['payment-routing.md'],
      hypothesize: true,
      compareGraph: false,
    });
    const docDurationMs = Date.now() - docStartTime;

    console.log(`   Audited in ${docDurationMs}ms`);
    console.log(`   Hypothesis Summary: ${docReport.hypothesis?.summary}`);
    console.log(`   Confidence: ${docReport.hypothesis?.confidence}`);
    console.log(`   Suggested Edits: ${docReport.hypothesis?.suggestedEdits.length}`);

    benchmarkLines.push('## Scenario 1: Mangled Documentation & Local Model Diagram Synthesis');
    benchmarkLines.push(`- **Target Workspace:** \`${customPkg.name}\``);
    benchmarkLines.push(`- **Audited File:** \`payment-routing.md\``);
    benchmarkLines.push(`- **Execution Latency:** ${docDurationMs}ms`);
    benchmarkLines.push(`- **Hypothesis Summary:** ${docReport.hypothesis?.summary}`);
    benchmarkLines.push(`- **Confidence Score:** ${docReport.hypothesis?.confidence}`);
    benchmarkLines.push('### Generated Mermaid Architecture Diagram:');
    benchmarkLines.push('');
    for (const edit of docReport.hypothesis?.suggestedEdits || []) {
      benchmarkLines.push(`#### Module: \`${edit.filePath}\``);
      benchmarkLines.push(edit.content);
      benchmarkLines.push('');
    }

    // 2. Skill Drift Remediation via Local LLM
    console.log('\n2. Remediating drifted skill in foreign workspace via local LLM...');
    const driftedSkill = `---
name: payment-settlement-audit
description: Audits ledger transaction consistency across Stripe and Adyen
---

# Payment Settlement Audit
Audits settlement transactions against Redis cache and database records.
`;
    const skillStartTime = Date.now();
    const skillResult = await auditor.applySkillDriftRemediation({
      skillContent: driftedSkill,
      driftReason: 'Missing ## When to Use, ## Limitations, and strict Output format contract for payment settlement workflows',
      workspaceRoot: tmpDir,
      allowCloudFallback: false,
    });
    const skillDurationMs = Date.now() - skillStartTime;

    console.log(`   Skill remediation in ${skillDurationMs}ms`);
    console.log(`   Remediation Type: ${skillResult.remediationType}`);
    console.log(`   Local Model Used: ${skillResult.localModelUsed}`);

    benchmarkLines.push('---');
    benchmarkLines.push('');
    benchmarkLines.push('## Scenario 2: Agent Skill Drift Remediation via Local LLM');
    benchmarkLines.push(`- **Target Workspace:** \`${customPkg.name}\``);
    benchmarkLines.push(`- **Target Skill:** \`payment-settlement-audit\``);
    benchmarkLines.push(`- **Execution Latency:** ${skillDurationMs}ms`);
    benchmarkLines.push(`- **Remediation Strategy:** \`${skillResult.remediationType}\``);
    benchmarkLines.push(`- **Local Model Engaged:** \`${skillResult.localModelUsed}\``);
    benchmarkLines.push('### Remediated Skill Content:');
    benchmarkLines.push('```markdown');
    benchmarkLines.push(skillResult.patchedContent);
    benchmarkLines.push('```');
    benchmarkLines.push('');

    // Write benchmark report
    await fs.writeFile(benchmarkFile, benchmarkLines.join('\n'), 'utf-8');
    console.log(`\n✓ Benchmark results successfully documented in:\n  ${benchmarkFile}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('Smoke benchmark failed:', err);
  process.exit(1);
});
