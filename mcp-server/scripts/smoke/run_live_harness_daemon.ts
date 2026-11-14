/**
 * Live harness worker daemon:
 * Runs in workspace background.
 * Lead Agent (Local / Ollama Laya) orchestrates research on arXiv papers,
 * while assistant models summarize and extract limitations.
 * Writes real-time run state to .free-llm-mcp/harness/<runId>/
 */
import { agentHarness } from '../../src/tools/agent-harness.js';
import path from 'node:path';

async function main() {
  const workspaceRoot = process.cwd();
  console.log(`[Harness Daemon] Starting in workspace: ${workspaceRoot}`);

  const goal = 'Continuous arXiv Intelligence Agent: Track, extract, and analyze key methodologies and test-time compute scaling laws from recent reasoning papers.';

  console.log(`[Harness Daemon] Deploying harness with local lead orchestrator...`);
  const deployRes = await agentHarness({
    action: 'deploy',
    harness: 'research-analysis',
    goal,
    workspace_root: workspaceRoot,
    maxTokens: 50000,
  });

  const runId = deployRes.run.runId;
  console.log(`[Harness Daemon] Successfully deployed run: ${runId}`);

  // Loop to monitor and resume progress
  for (let cycle = 1; cycle <= 10; cycle++) {
    await new Promise(r => setTimeout(r, 4000));
    const status = await agentHarness({
      action: 'status',
      runId,
      workspace_root: workspaceRoot,
    });
    console.log(`[Harness Daemon Cycle ${cycle}] Run ${runId}: status=${(status as any).run?.status}, step=${(status as any).run?.stepIndex ?? 0}`);

    const tasks = await agentHarness({
      action: 'tasks',
      runId,
      workspace_root: workspaceRoot,
    });
    console.log(`[Harness Daemon Cycle ${cycle}] Blackboard Tasks: ${(tasks as any).tasks?.length ?? 0} items`);

    if ((status as any).run?.status === 'completed' || (status as any).run?.status === 'paused_approval') {
      console.log(`[Harness Daemon] Terminal or approval state reached: ${(status as any).run?.status}`);
      break;
    }
  }

  console.log(`[Harness Daemon] Monitoring active and telemetry linked to dashboard.`);
}

main().catch(err => {
  console.error('[Harness Daemon Error]:', err);
});
