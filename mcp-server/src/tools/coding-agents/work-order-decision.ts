import { missingLiterals, workOrderNote, triageDeviation, type TriageAction, type TriageCause, type TriageResult } from './work-order.js';

export interface WorkOrderCheckInput {
  goal: string;
  patchPlan: Array<{ fullPatchedContent?: unknown }>;
  brief: string;
  cloudAllowed: boolean;
  preferCloud: boolean;
}

export interface WorkOrderCheck {
  brief: string;
  cause?: TriageCause;
  action?: TriageAction;
  /** Set only when the next attempt should use the other kind of model. */
  preferCloud?: boolean;
}

type Triage = (facts: { goal: string; missing: string[]; brief: string }) => Promise<TriageResult>;

/**
 * When the goal supplied exact text and the edit lacks it: puts that text in front of the next brief, asks triage
 * what to do, and says whether the next attempt should switch between the local and the cloud model.
 */
export async function checkWorkOrder(input: WorkOrderCheckInput, triage: Triage = async facts => process.env.CODING_AGENTS_TRIAGE_MODEL ? triageDeviation(facts) : { cause: 'not_copied', action: 'reroute', source: 'rule' }): Promise<WorkOrderCheck> {
  const contents = input.patchPlan.map(p => p.fullPatchedContent).filter((c): c is string => typeof c === 'string');
  if (contents.length === 0) return { brief: input.brief };
  const missing = missingLiterals(input.goal, contents);
  if (missing.length === 0) return { brief: input.brief };
  const decision = await triage({ goal: input.goal, missing, brief: input.brief });
  const result: WorkOrderCheck = { brief: `${workOrderNote(missing)}\n\n${input.brief}`, cause: decision.cause, action: decision.action };
  if (decision.action === 'reroute' && input.cloudAllowed) result.preferCloud = !input.preferCloud;
  return result;
}
/**
 * Names the supplied text a green edit left out.
 * @param goal - The goal provided.
 * @param patchPlan - The patch plan containing the full patched content.
 * @returns The missing text or undefined if everything is patched.
 */
export function unfinishedBrief(goal: string, patchPlan: Array<{ fullPatchedContent?: unknown }>): string | undefined {
  const contents = patchPlan.map(p => p.fullPatchedContent).filter((c): c is string => typeof c === 'string');
  if (contents.length === 0) return undefined;
  const missing = missingLiterals(goal, contents);
  if (missing.length === 0) return undefined;
  return workOrderNote(missing);
}
// #145: repeating a goal that only adds lines must not add them again.
// #146: an edit that changes nothing is not converged, whatever the check says.
export function noChangeBrief(patchPlan: Array<{ unchanged?: boolean }>): string | undefined {
    return patchPlan.length > 0 && patchPlan.every(p => p.unchanged === true) ? 'Your last edit changed nothing in the file. Make the change the goal asks for.' : undefined;
}
