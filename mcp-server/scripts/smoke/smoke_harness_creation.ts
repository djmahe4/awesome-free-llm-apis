/**
 * Smoke test for agent_harness deployment & execution:
 * Deploys an arXiv research & analysis harness where local model (laya / Ollama)
 * coordinates as the continuous lead agent, while external assistant roles analyze and synthesize.
 */
import { agentHarness } from '../../src/tools/agent-harness.js';
import { HarnessStore } from '../../src/harness/store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function main() {
  console.log('=== Starting Smoke: Agent Harness Creation & Execution ===\n');

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-smoke-ws-'));
  console.log(`1. Initialized throwaway workspace: ${tmpWs}`);

  // Deploy harness with an arXiv paper reading & research goal
  const goal = 'Research recent arXiv papers on "Large Language Model Reasoning Trajectories and Test-Time Compute Scaling". Extract key findings, methodology, and limitations.';
  console.log(`2. Deploying harness with goal:\n   "${goal}"\n`);

  const deployResult = await agentHarness({
    action: 'deploy',
    harness: 'research-analysis',
    goal,
    workspace_root: tmpWs,
    maxTokens: 30000,
  });

  console.log('3. Deploy result:', JSON.stringify(deployResult, null, 2));
  const runId = deployResult.run.runId;
  console.log(`   Assigned Run ID: ${runId}`);
  console.log(`   Initial status: ${deployResult.run.status}`);
  console.log(`   Assigned lead role: ${deployResult.run.role}`);

  // Verify status action
  const statusResult = await agentHarness({
    action: 'status',
    runId,
    workspace_root: tmpWs,
  });
  console.log(`\n4. Status verification:\n   Status: ${(statusResult as any).run?.status || 'unknown'}, Current Step: ${(statusResult as any).run?.stepIndex ?? 0}`);

  // Inspect tasks and blackboard
  const tasksResult = await agentHarness({
    action: 'tasks',
    runId,
    workspace_root: tmpWs,
  });
  console.log(`\n5. Tasks blackboard check:`);
  console.log(`   Tasks file: ${(tasksResult as any).tasksFile ?? 'N/A'}`);
  console.log(`   Tasks items count: ${(tasksResult as any).tasks?.length ?? 0}`);

  // Inspect trace events
  const traceResult = await agentHarness({
    action: 'trace',
    runId,
    workspace_root: tmpWs,
    limit: 10,
  });
  console.log(`\n6. Telemetry & trace checks:`);
  console.log(`   Trace events recorded: ${(traceResult as any).trace?.length ?? 0}`);

  // Clean up
  try {
    fs.rmSync(tmpWs, { recursive: true, force: true });
    console.log(`\n7. Cleaned up workspace: ${tmpWs}`);
  } catch (err) {
    console.warn('Cleanup notice:', err);
  }

  console.log('\n=== Smoke Test: Harness Creation PASSED ===');
}

main().catch(err => {
  console.error('Smoke harness creation error:', err);
  process.exit(1);
});
