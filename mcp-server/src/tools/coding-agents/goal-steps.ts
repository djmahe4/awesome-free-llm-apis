import type { CodingAgentsInput, CodingAgentsResult } from './types.js';

type Rollback = (checkpointId: string, newFiles: string[]) => Promise<string[]>;

/** The steps of a goal written as "Step 1: ... Step 2: ...", each with the intro in front; empty unless there are two or more. */
export function splitSteps(goal: string): string[] {
  const hidden = goal.replace(/\u0060[^\u0060]*\u0060/g, span => 'x'.repeat(span.length));
  const marker = /\b(?:step|edit|change)\s*\d+\s*[:.)]\s*/gi;
  const hits = [...hidden.matchAll(marker)];
  if (hits.length < 2) return [];
  const intro = goal.slice(0, hits[0].index).trimStart();
  return hits.map((hit, i) => intro + goal.slice(hit.index + hit[0].length, i + 1 < hits.length ? hits[i + 1].index : goal.length).trim());
}

/**
 * Runs the steps in order. The check runs only after the last step, because an earlier step cannot be expected to
 * pass it alone. Anything short of a clean finish restores the state from before step 1.
 */
export async function runSteps(
  input: CodingAgentsInput,
  steps: string[],
  runStep: (step: CodingAgentsInput) => Promise<CodingAgentsResult>,
  rollback?: Rollback,
): Promise<CodingAgentsResult> {
  let firstCheckpoint: string | undefined;
  const attempts: NonNullable<CodingAgentsResult['repair']>['attempts'] = [];
  let result!: CodingAgentsResult;
  for (let i = 0; i < steps.length; i++) {
      const last = i === steps.length - 1;
      result = await runStep({ ...input, goal: steps[i], verifyCommand: last ? input.verifyCommand : undefined });
      firstCheckpoint ??= result.checkpointId;
      attempts.push(...(result.repair?.attempts ?? []));
      const finished = !result.error && result.applied && (!result.repair || result.repair.outcome === 'converged' || result.repair.outcome === 'unverified');
      if (!finished) {
          if (firstCheckpoint && rollback) result.restoredFiles = await rollback(firstCheckpoint, []);
          result.applied = false;
          result.status = 'rollback';
          result.message = 'Step ' + (i + 1) + ' of ' + steps.length + ' did not finish, so the state from before step 1 was restored. ' + (result.message ?? '');
          break;
      }
  }
  if (result.repair) result.repair = { ...result.repair, attemptCount: attempts.length, attempts };
  return result;
}
