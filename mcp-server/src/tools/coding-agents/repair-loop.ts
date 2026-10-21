import type { RunInfo } from '../../pipeline/middlewares/RunRegistry.js';
import type { CodingAgentsInput, CodingAgentsResult, RepairAttempt } from './types.js';

/**
 * Bounded repair loop around one pipeline run.
 *
 * A failed behavioural check (verification.status 'regressed', already rolled back) or a blocking
 * review produces a debugger brief; the next attempt gets it as `feedback`. Each attempt starts from a
 * clean tree because a regression is rolled back before the loop sees it.
 *
 * It ends honestly: converged | not_converged (budget spent) | stuck (the same failure twice, so more
 * retries would only burn tokens) | needs_user (the human must run the tests) | error.
 */

export const MAX_REPAIR_ATTEMPTS = 3;
const DEFAULT_REPAIR_ATTEMPTS = 3;
/** Greedy decoding returns the same answer for the same prompt, so each retry samples a little hotter. */
const RETRY_TEMPERATURE = (attempt: number) => Math.min(0.9, 0.3 * (attempt - 1));

type Runner = (input: CodingAgentsInput, sessionId: string, run?: RunInfo) => Promise<CodingAgentsResult>;
/** Restores the tree to a CAS checkpoint (and deletes files the agent created); returns what it restored. */
type Rollback = (checkpointId: string, newFiles: string[]) => Promise<string[]>;

function attemptOutcome(r: CodingAgentsResult): string {
  if (r.verification?.status) return r.verification.status;
  if (r.review?.verdict === 'blocked') return 'review_blocked';
  if (r.error) return 'error';
  return r.applied ? 'applied' : 'proposed';
}

function briefOf(r: CodingAgentsResult, input: CodingAgentsInput): string | undefined {
  // With a verifyCommand the check is the judge (the reviewer does not even run: in live runs a 7B
  // reviewer repeatedly insisted spec-correct code was wrong).
  if (input.verifyCommand) {
    if ((r.verification?.status !== 'regressed' && r.verification?.status !== 'not_green') || !r.verification.repairBrief) return undefined;
    return r.verification.repairBrief;
  }
  if (input.review !== false && r.review?.verdict === 'blocked' && r.review.brief) return r.review.brief;
  return undefined;
}

export async function runWithRepairLoop(
  input: CodingAgentsInput,
  sessionId: string,
  run: RunInfo | undefined,
  runner: Runner,
  rollback?: Rollback,
): Promise<CodingAgentsResult> {
  // Deterministic AST edits cannot be "re-generated", so there is nothing to repair by retrying.
  const retriable = !(input.astEditOps && input.astEditOps.length > 0);
  const budget = retriable ? Math.min(MAX_REPAIR_ATTEMPTS, Math.max(0, input.maxRepairAttempts ?? DEFAULT_REPAIR_ATTEMPTS)) : 0;

  const attempts: RepairAttempt[] = [];
  let current = input;
  let lastBrief: string | undefined;
  let result!: CodingAgentsResult;
  // The first apply's checkpoint is the ORIGINAL tree; files the agent created across attempts.
  let originalCheckpoint: string | undefined;
  const createdFiles = new Set<string>();
  let outcome: NonNullable<CodingAgentsResult['repair']>['outcome'] = 'converged';

  for (let n = 1; ; n++) {
    result = await runner(current, sessionId, run);
    if (!originalCheckpoint && result.checkpointId && result.applied) originalCheckpoint = result.checkpointId;
    for (const p of result.patchPlan ?? []) if ((p as any).isNewFile) createdFiles.add(p.filePath);
    const brief = briefOf(result, input);
    attempts.push({
      attempt: n,
      outcome: attemptOutcome(result),
      ...(result.verification?.failedCases ? { failing: result.verification.failedCases.length } : {}),
      ...(current.rewrite ? { rewrite: true } : {}),
      ...(brief ? { brief: brief.slice(0, 600) } : {}),
    });

    if (result.error) { outcome = 'error'; break; }
    if (result.verification?.status === 'needs_user') { outcome = 'needs_user'; break; }
    if (!brief) { outcome = 'converged'; break; }
    if (n > budget) { outcome = 'not_converged'; break; }
    // The same failure twice at a raised temperature means more retries would only burn tokens.
    if (brief === lastBrief && (current.temperature ?? 0) >= 0.6) { outcome = 'stuck'; break; }
    lastBrief = brief;
    // Many failing cases mean the logic is wrong, not one line: patching it line by line moves sideways
    // (observed live), so regenerate the file from the requirements plus the brief.
    // A rewrite must start from the ORIGINAL file: shown its own broken code the model copies it
    // unchanged (observed live: identical no-op proposals, 6 failing every time).
    // Not sticky: an attempt that came close (few failing cases) is patched in place next time.
    const wantRewrite = (result.verification?.failedCases?.length ?? 0) > 3;
    const rewrite = wantRewrite && !!rollback && !!originalCheckpoint;
    if (rewrite) {
      await rollback!(originalCheckpoint!, [...createdFiles]);
    }
    current = { ...input, feedback: brief, temperature: RETRY_TEMPERATURE(n + 1), ...(rewrite ? { rewrite: true } : {}) };
  }

  // Test-first work keeps a still-red attempt applied so the next one can build on it. If it never went
  // green, do not leave the user's tree changed by an unverified attempt: restore the original.
  if ((outcome === 'not_converged' || outcome === 'stuck') && result.verification?.status === 'not_green' && result.applied && originalCheckpoint && rollback) {
    result.restoredFiles = await rollback(originalCheckpoint, [...createdFiles]);
    result.applied = false;
    result.message = `The check never went green after ${attempts.length} attempt(s), so the original files were restored. The last proposal is in patchSummary; result.verification.repairBrief says what was still failing.`;
  }

  // Only attach the record when the loop mattered (a check or a review took part).
  if (input.verifyCommand || result.review || attempts.length > 1) {
    result.repair = { outcome, attemptCount: attempts.length, attempts };
  }
  return result;
}
