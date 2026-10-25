import { caTrace, caTraceReset } from './trace.js';
import type { RunInfo } from '../../pipeline/middlewares/RunRegistry.js';
import type { CodingAgentsInput, CodingAgentsResult, RepairAttempt } from './types.js';
import { detectSpecialCasing } from './verify-guard.js';

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

export const MAX_REPAIR_ATTEMPTS = 5;
const DEFAULT_REPAIR_ATTEMPTS = 4;
/** A local 7B run is ~1 min per attempt; without a cap one goal ran 20+ minutes. */
const DEFAULT_MAX_DURATION_MS = 5 * 60_000;
/** Greedy decoding returns the same answer for the same prompt, so each retry samples a little hotter. */
const RETRY_TEMPERATURE = (attempt: number) => Math.min(0.9, Math.round(3 * (attempt - 1)) / 10);

type Runner = (input: CodingAgentsInput, sessionId: string, run?: RunInfo) => Promise<CodingAgentsResult>;
/** Restores the tree to a CAS checkpoint (and deletes files the agent created); returns what it restored. */
type Rollback = (checkpointId: string, newFiles: string[]) => Promise<string[]>;
/** Writes known file contents back (used to return to the best attempt after a worse one). */
type RestoreFiles = (files: Array<{ filePath: string; content: string }>) => Promise<void>;

export const MAX_SAMPLES = 5;
/** Temperatures of the independent samples after the first (the first stays deterministic). */
const SAMPLE_TEMPERATURES = [0.4, 0.6, 0.8, 0.8];

/** Attempts at or under this many failing cases are patched in place; above it the file is rewritten. */
const NEAR_MISS = 3;

/**
 * Which target files a failure points at: a stack frame inside the file, or a failing test named after it
 * ("cart uses its currency" -> src/cart.js). Empty when nothing specific (or every file) is implicated,
 * which means: do not narrow.
 */
export function filesImplicated(targets: string[], failedCases: string[], brief: string): string[] {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const text = norm(brief);
  const hit = targets.filter(t => {
    const rel = norm(t);
    const base = rel.split('/').pop()!.replace(/\.[^.]+$/, '');
    // Frames: "src/cart.js:12" (JS, Go, Rust, most tools) and Python's 'File ".../src/cart.py", line 12'.
    if (text.includes(`/${rel}:`) || text.includes(`${rel}:`) || text.includes(`/${rel}", line`) || text.includes(`"${rel}", line`)) return true;
    const word = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return failedCases.length > 0 && base.length >= 3 && failedCases.every(c => word.test(c));
  });
  return hit.length > 0 && hit.length < targets.length ? hit : [];
}

function attemptOutcome(r: CodingAgentsResult): string {
  if (r.rollbackBrief) return 'rolled_back_syntax';
  if (r.verification?.status) return r.verification.status;
  if (r.review?.verdict === 'blocked') return 'review_blocked';
  if (r.error) return 'error';
  return r.applied ? 'applied' : 'proposed';
}

function briefOf(r: CodingAgentsResult, input: CodingAgentsInput): string | undefined {
  // An edit that does not parse is rolled back before any check can run; its compiler messages are the feedback.
  if (r.rollbackBrief && !r.applied) return r.rollbackBrief;
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
  restoreFiles?: RestoreFiles,
): Promise<CodingAgentsResult> {
  // Deterministic AST edits cannot be "re-generated", so there is nothing to repair by retrying.
  const retriable = !(input.astEditOps && input.astEditOps.length > 0);
  const repairBudget = retriable ? Math.min(MAX_REPAIR_ATTEMPTS, Math.max(0, input.maxRepairAttempts ?? DEFAULT_REPAIR_ATTEMPTS)) : 0;
  // Independent candidates drawn from the ORIGINAL file (tests are the verifier). Needs a way to get back
  // to the original between candidates, and an objective check to compare them by.
  const samples = retriable && input.verifyCommand && rollback
    ? Math.min(MAX_SAMPLES, Math.max(1, Math.floor(input.samples ?? 1)))
    : 1;
  // Sampling attempts come first and do not consume the repair budget.
  const budget = repairBudget + (samples - 1);

  const attempts: RepairAttempt[] = [];
  let current = input;
  let lastBrief: string | undefined;
  let result!: CodingAgentsResult;
  // The first apply's checkpoint is the ORIGINAL tree; files the agent created across attempts.
  let originalCheckpoint: string | undefined;
  // The closest attempt so far (fewest failing cases): later attempts repair THAT, not merely the latest.
  let best: { failing: number; brief: string; files: Array<{ filePath: string; content: string }>; isOriginal?: boolean; cases?: string[] } | undefined;
  let latestIsBest = false;
  const createdFiles = new Set<string>();
  const deadline = Date.now() + (Number.isFinite(input.maxDurationMs) && (input.maxDurationMs as number) > 0 ? (input.maxDurationMs as number) : DEFAULT_MAX_DURATION_MS);
  let outcome: NonNullable<CodingAgentsResult['repair']>['outcome'] = 'converged';

  // Narrow a patch-in-place retry to the files the failure implicates; the rest stay as reference.
  const narrowTo = (cases: string[], brief: string): Partial<CodingAgentsInput> => {
    if (!input.targetFiles || input.targetFiles.length < 2) return {};
    const hit = filesImplicated(input.targetFiles, cases, brief);
    return hit.length > 0 ? { targetFiles: hit, relatedFiles: input.targetFiles.filter(f => !hit.includes(f)) } : {};
  };

  for (let n = 1; ; n++) {
    if (run?.controller.signal.aborted && n === 1) {
      result = { sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false };
      outcome = 'aborted';
      break;
    }
    // The pipeline counts files per run; without this reset the status poll reads "2/1 file(s)" on attempt 2.
    if (run) run.completedCount = 0;
    if (n === 1) caTraceReset(sessionId);
    caTrace(`attempt ${n} start`, `temp=${current.temperature ?? 0}${current.rewrite ? ' rewrite' : ''}`);
    result = await runner(current, sessionId, run);
    caTrace(`attempt ${n} end`, String(result.verification?.status ?? (result.applied ? 'applied' : 'proposed')));
    if (!originalCheckpoint && result.checkpointId && result.applied) originalCheckpoint = result.checkpointId;
    for (const p of result.patchPlan ?? []) if ((p as any).isNewFile) createdFiles.add(p.filePath);
    let brief = briefOf(result, input);
    if (brief) {
      // Lines the failed edit added; if they contain a failing test input verbatim, say so.
      const added = (result.patchPlan ?? []).flatMap(p => {
        const before = new Set(String((p as any).originalSnippet ?? '').split(/\r?\n/).map(l => l.trim()));
        return String((p as any).replacementSnippet ?? '').split(/\r?\n/).filter(l => l.trim() && !before.has(l.trim()));
      });
      const hard = detectSpecialCasing(added, result.verification?.failedCases ?? []);
      if (hard.length > 0) {
        brief += `\n\nYour last edit hard-coded the input ${hard.map(h => `"${h}"`).join(', ')}. That is not a fix: find what makes the code accept or mishandle it in general, and change that.`;
      }
    }
    const failing = result.verification?.failedCases?.length;
    if (brief && failing !== undefined) {
      const files = (result.patchPlan ?? [])
        .filter(p => typeof (p as any).fullPatchedContent === 'string')
        .map(p => ({ filePath: p.filePath, content: (p as any).fullPatchedContent as string }));
      latestIsBest = !best || failing < best.failing;
      if (latestIsBest) best = { failing, brief, files, cases: result.verification?.failedCases ?? [] };
      // The tree we started from is also a candidate: if it was closer to green than this attempt, the
      // next attempt repairs THAT (with the baseline's brief) instead of rewriting or building on a regression.
      const v = result.verification;
      if (v?.baselineBrief && v.baselineFailedCases && v.baselineFailedCases.length < failing && v.baselineFailedCases.length < (best?.failing ?? Infinity) + (latestIsBest ? 1 : 0)) {
        best = { failing: v.baselineFailedCases.length, brief: v.baselineBrief, files: [], isOriginal: true };
        latestIsBest = false;
      }
    }
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
    if (run?.controller.signal.aborted) { outcome = 'aborted'; break; }
    if (Date.now() >= deadline) { outcome = 'timed_out'; break; }
    if (n > budget) { outcome = 'not_converged'; break; }

    // ── sampling phase: independent candidates from the original ─────────────────────────
    if (n < samples) {
      if (originalCheckpoint) {
        await rollback!(originalCheckpoint, [...createdFiles]);
        // Independent samples from the original, but not blind: they are told which cases the original
        // fails (the baseline run), which is the whole point when it is one edge case in good code.
        const baselineBrief = result.verification?.baselineBrief;
        current = {
          ...input,
          temperature: SAMPLE_TEMPERATURES[Math.min(n - 1, SAMPLE_TEMPERATURES.length - 1)],
          ...(baselineBrief ? { feedback: baselineBrief } : {}),
        };
        continue;
      }
    } else if (n === samples && samples > 1 && best && originalCheckpoint) {
      // Sampling is over: continue from the closest candidate. The first repair try is a shade hotter
      // than greedy, and runs on the best candidate (restored if it was not the last one drawn).
      if (best.failing > NEAR_MISS && !best.isOriginal) {
        await rollback!(originalCheckpoint, [...createdFiles]);
        current = { ...input, feedback: best.brief, temperature: 0.3, rewrite: true };
      } else {
        if (!latestIsBest) {
          await rollback!(originalCheckpoint, [...createdFiles]);
          if (!best.isOriginal && restoreFiles && best.files.length > 0) await restoreFiles(best.files);
        }
        current = { ...input, feedback: best.brief, temperature: 0.3, ...narrowTo(best.cases ?? [], best.brief) };
      }
      lastBrief = best.brief;
      continue;
    }
    // The same failure twice even at the hottest sampling temperature: more retries would only burn tokens.
    // (Below that, a repeat is expected from a near-deterministic sampler and is not yet proof of being stuck.)
    if (brief === lastBrief && (current.temperature ?? 0) >= 0.9) { outcome = 'stuck'; break; }
    lastBrief = brief;
    // Many failing cases mean the logic is wrong, not one line: patching it line by line moves sideways
    // (observed live), so regenerate the file from the requirements plus the brief.
    // A rewrite must start from the ORIGINAL file: shown its own broken code the model copies it
    // unchanged (observed live: identical no-op proposals, 6 failing every time).
    // Not sticky: an attempt that came close (few failing cases) is patched in place next time.
    const bestIsNearMiss = !!best && best.failing <= NEAR_MISS;
    const canReset = !!rollback && !!originalCheckpoint;
    let nextBrief = brief;
    let rewrite = false;
    if (bestIsNearMiss) {
      // Patch the closest attempt in place; if the latest attempt was worse, go back to the best first.
      if (!latestIsBest && canReset && (best!.isOriginal || (restoreFiles && best!.files.length > 0))) {
        await rollback!(originalCheckpoint!, [...createdFiles]);
        if (!best!.isOriginal) await restoreFiles!(best!.files);
        nextBrief = best!.brief;
      }
    } else if (canReset && !!best && best.failing > NEAR_MISS) {
      // Only when we KNOW many cases fail; with no failing count the attempt is simply continued.
      rewrite = true;
      await rollback!(originalCheckpoint!, [...createdFiles]);
      nextBrief = best?.brief ?? brief;
    }
    // A patch-in-place retry edits only the files the failure points at: re-editing files that already pass
    // broke them in traced multi-file runs. A rewrite starts from the original tree, so it keeps all files.
    current = {
      ...input, feedback: nextBrief, temperature: RETRY_TEMPERATURE(n - samples + 2),
      ...(rewrite ? { rewrite: true } : narrowTo(result.verification?.failedCases ?? [], nextBrief)),
    };
  }

  // Test-first work keeps a still-red attempt applied so the next one can build on it. If it never went
  // green, do not leave the user's tree changed by an unverified attempt: restore the original.
  if ((outcome === 'not_converged' || outcome === 'stuck' || outcome === 'aborted' || outcome === 'timed_out') && result.verification?.status === 'not_green' && result.applied && originalCheckpoint && rollback) {
    result.restoredFiles = await rollback(originalCheckpoint, [...createdFiles]);
    result.applied = false;
    result.message = outcome === 'aborted'
      ? `Aborted after ${attempts.length} attempt(s); the original files were restored.`
      : outcome === 'timed_out'
        ? `The time budget ran out after ${attempts.length} attempt(s) and the check was still red, so the original files were restored. Raise maxDurationMs or narrow the goal.`
        : `The check never went green after ${attempts.length} attempt(s), so the original files were restored. The last proposal is in patchSummary; result.verification.repairBrief says what was still failing.`;
  } else if (outcome === 'aborted') {
    result.message = `Aborted after ${attempts.length} attempt(s).`;
  } else if (outcome === 'timed_out') {
    result.message = `The time budget ran out after ${attempts.length} attempt(s).`;
  }

  // Only attach the record when the loop mattered (a check or a review took part).
  if (input.verifyCommand || result.review || attempts.length > 1) {
    result.repair = { outcome, attemptCount: attempts.length, attempts };
  }
  return result;
}
