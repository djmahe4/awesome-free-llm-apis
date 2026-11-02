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
export async function checkWorkOrder(input: WorkOrderCheckInput, triage: Triage = facts => triageDeviation(facts)): Promise<WorkOrderCheck> {
  const contents = input.patchPlan.map(p => p.fullPatchedContent).filter((c): c is string => typeof c === 'string');
  if (contents.length === 0) return { brief: input.brief };
  const missing = missingLiterals(input.goal, contents);
  if (missing.length === 0) return { brief: input.brief };
  const decision = await triage({ goal: input.goal, missing, brief: input.brief });
  const result: WorkOrderCheck = { brief: `${workOrderNote(missing)}\n\n${input.brief}`, cause: decision.cause, action: decision.action };
  if (decision.action === 'reroute' && input.cloudAllowed) result.preferCloud = !input.preferCloud;
  return result;
}
