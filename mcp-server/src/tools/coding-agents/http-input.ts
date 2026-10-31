import type { CodingAgentsInput } from './types.js';

const ACTIONS = ['plan', 'execute', 'resume', 'status', 'abort'] as const;
const SESSION_ACTIONS = new Set(['resume', 'status', 'abort']);

/**
 * Builds the CodingAgentsInput for POST /api/coding_agents.
 *
 * The route used to copy seven named fields out of the body, so `action`, `targetFiles`,
 * `pauseOnTaskPlan`, `lspAction` and `astEditOps` were silently dropped: a status poll started a
 * brand-new dry run with goal "status". The body is now forwarded as a whole (like the
 * /api/tools dispatcher and agent_harness), with only the defaults applied.
 */
export function normalizeCodingAgentsHttpInput(
  body: unknown,
  defaultWorkspaceRoot: string,
): { input: CodingAgentsInput } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const action = b.action;
  if (action !== undefined && !(ACTIONS as readonly string[]).includes(action)) {
    return { error: `unknown action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(', ')}` };
  }
  if (!b.goal && !b.verifyReport && !(action && SESSION_ACTIONS.has(action))) return { error: 'goal is required' };
  return {
    input: {
      ...b,
      goal: b.goal ?? '',
      workspaceRoot: b.workspaceRoot ?? defaultWorkspaceRoot,
      dryRun: b.dryRun ?? true,
      topKFiles: b.topKFiles ?? 5,
      verifyLspDiagnostics: b.verifyLspDiagnostics ?? true,
    } as CodingAgentsInput,
  };
}
