import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MCP_DIR = '/home/kali/Desktop/awesome-free-llm-apis/mcp-server';
const WORKSPACE = '/home/kali/Desktop/AVST/ctf-katana';
const GOAL = 'bug-bounty recon and ctf vulnerability hunt on localhost for the bug_hunting skill';

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

function parseToolJson(res: any): any {
  const text = res?.content?.find((c: any) => c.type === 'text')?.text;
  if (!text) return { __raw: res };
  try { return JSON.parse(text); } catch { return { __text: text, isError: res?.isError }; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const env = loadEnv(path.join(MCP_DIR, '.env'));
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/server.js'],
    cwd: MCP_DIR,
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) process.stderr.write(`[server] ${s}\n`);
  });

  const client = new Client({ name: 'hitl-bug-hunting-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('[+] Connected to MCP server (dist/server.js)');

  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: 'agent_harness', arguments: args });
    return parseToolJson(res);
  };

  // 1) Deploy
  const deploy = await call({
    action: 'deploy',
    harness: 'appsec',
    goal: GOAL,
    workspace_root: WORKSPACE,
    maxTokens: 40000,
  });
  if (!deploy?.success) {
    console.error('[-] deploy failed:', JSON.stringify(deploy, null, 2));
    process.exitCode = 1;
    await client.close();
    return;
  }
  const runId = deploy.run?.runId;
  console.log(`[+] Deployed runId=${runId} status=${deploy.run?.status} harness=${deploy.run?.harness}`);

  // 2) Poll loop with HITL
  let hitlCount = 0;
  let lastStatus = '';
  let sawExecuteSkill = false;
  let sawApprovalRequested = false;
  let sawApprovalDecided = false;
  let sawBugHuntingTag = false;

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const status = await call({ action: 'status', runId, workspace_root: WORKSPACE });
    const run = status.run || {};
    const st = `${run.status} step=${run.stepIndex ?? '?'} err=${(run.error || '').slice(0, 120)}`;
    if (st !== lastStatus) {
      console.log(`[status t+${(i + 1) * 3}s] ${st} pendingApprovals=${status.pendingApprovals ?? 0}`);
      lastStatus = st;
    }

    const trace = await call({ action: 'trace', runId, workspace_root: WORKSPACE, limit: 500 });
    for (const ev of trace.events || []) {
      if (ev.type === 'tool_call' && (ev.data?.tool === 'execute_skill' || ev.data?.requestedTool === 'execute_skill')) sawExecuteSkill = true;
      if (ev.type === 'tool_call' && JSON.stringify(ev.data || {}).includes('bug_hunting')) sawBugHuntingTag = true;
      if (ev.type === 'policy_decision' && ev.data?.tool === 'execute_skill') sawExecuteSkill = true;
      if (ev.type === 'approval_requested') sawApprovalRequested = true;
      if (ev.type === 'approval_decided' && ev.data?.status === 'approved') sawApprovalDecided = true;
      if (ev.type === 'phase' || ev.type === 'run_start' || ev.type === 'policy_decision' || ev.type === 'tool_call' || ev.type === 'approval_requested' || ev.type === 'error' || ev.type === 'budget') {
        // already logged on change below
      }
    }

    // HITL: approve any pending approvals
    if (run.status === 'paused_approval' || (status.pendingApprovals ?? 0) > 0) {
      const approvals = await call({ action: 'approvals', runId, workspace_root: WORKSPACE });
      const pending = (approvals.approvals || []).filter((a: any) => a.status === 'pending');
      for (const a of pending) {
        hitlCount++;
        console.log(`[HITL #${hitlCount}] approving id=${a.id} role=${a.role} tool=${a.tool} reason=${a.reason}`);
        console.log(`  argsHash=${a.argsHash} args=${JSON.stringify(a.args).slice(0, 300)}`);
        const approved = await call({
          action: 'approve',
          runId,
          workspace_root: WORKSPACE,
          approvalId: a.id,
          note: 'HITL test: approved by live MCP client after reviewing harness policy gate.',
        });
        console.log(`  approve => success=${approved.success} status=${approved.approval?.status}`);
      }
      if (pending.length > 0) {
        const resumed = await call({ action: 'resume', runId, workspace_root: WORKSPACE });
        console.log(`[resume] success=${resumed.success} status=${resumed.run?.status} err=${(resumed.run?.error || '').slice(0, 160)}`);
        continue;
      }
    }

    if (['complete', 'completed', 'failed', 'aborted', 'paused_budget'].includes(run.status)) {
      console.log(`[+] Terminal status reached: ${run.status}`);
      break;
    }
  }

  // Final evidence dump
  const finalStatus = await call({ action: 'status', runId, workspace_root: WORKSPACE });
  const finalTrace = await call({ action: 'trace', runId, workspace_root: WORKSPACE, limit: 500 });
  const finalApprovals = await call({ action: 'approvals', runId, workspace_root: WORKSPACE });
  const tasks = await call({ action: 'tasks', runId, workspace_root: WORKSPACE });

  console.log('\n==== FINAL STATUS ====');
  console.log(JSON.stringify({
    runId,
    status: finalStatus.run?.status,
    stepIndex: finalStatus.run?.stepIndex,
    error: finalStatus.run?.error,
    budget: finalStatus.run?.budget,
    pendingApprovals: finalStatus.pendingApprovals,
    hitlCount,
  }, null, 2));

  console.log('\n==== TRACE SUMMARY ====');
  const byType: Record<string, number> = {};
  for (const ev of finalTrace.events || []) byType[ev.type] = (byType[ev.type] || 0) + 1;
  console.log(JSON.stringify(byType, null, 2));
  console.log('\n---- key events ----');
  for (const ev of finalTrace.events || []) {
    if (['run_start', 'phase', 'policy_decision', 'tool_call', 'approval_requested', 'approval_decided', 'error', 'budget', 'run_end'].includes(ev.type)) {
      console.log(JSON.stringify(ev));
    }
  }

  console.log('\n==== APPROVALS ====');
  console.log(JSON.stringify(finalApprovals.approvals || [], null, 2));

  console.log('\n==== TASKS ====');
  console.log(JSON.stringify({ file: !!tasks.tasksFile, tasks: tasks.tasks }, null, 2));

  console.log('\n==== ASSERTIONS ====');
  const checks = {
    deployOk: !!runId,
    sawExecuteSkill,
    sawApprovalRequested,
    sawApprovalDecided,
    sawBugHuntingTag,
    hitlCount: hitlCount > 0,
    finalStatus: finalStatus.run?.status,
  };
  console.log(JSON.stringify(checks, null, 2));

  await client.close();
}

main().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
