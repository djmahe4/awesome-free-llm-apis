import { newDuplicateDefinitions } from './duplicate-defs.js';
import { localLlmPatch } from '../local-llm-patch.js';
import { caTrace, caTraceDump } from './trace.js';
import { crossFileContext } from './cross-file.js';
import { newImportProblems } from './import-check.js';
import { loadCodingAgentsSettings, SETTINGS_FILE } from './settings.js';
import { readVerifyTestContext } from './verify-guard.js';
import {
  extractWindowForInstruction,
  parseSearchReplaceBlocksDetailed,
  applySearchReplaceBlocks,
  isAdditiveInstruction,
  isEndOfFileInstruction,
  searchReplaceRegressesTsErrors,
  looksLikeHallucinatedReplacement,
  generateSearchReplacePatch,
  generateCodePatchWithCloudLLM,
  windowReplyIsSuspicious,
} from './patch-gen.js';
import type { CodingAgentsInput, CodingAgentsResult, TaskItem } from './types.js';
import type { RunInfo } from '../../pipeline/middlewares/RunRegistry.js';

/** Everything the per-file generation step reads from the run (extracted from runCodingAgentsPipeline). */
export interface FilePatchContext {
  input: CodingAgentsInput;
  /** Mutated in place: modelUsed, usedFallbackModel and diagnostics, exactly as the inline code did. */
  result: CodingAgentsResult;
  relPath: string;
  fullPath: string;
  workspaceRoot: string;
  sessionId: string;
  run?: RunInfo;
  resolvedModel: string | null | undefined;
  originalContent: string;
  activeGoal: string;
  loadedTasks?: TaskItem[];
  nextPendingTask?: TaskItem;
  changeFiles: string[];
  runContents: Map<string, string>;
  editedInRun: Set<string>;
}

/**
 * LLM generation for one file: SEARCH/REPLACE with the local model (one informed retry), then the
 * full-file / windowed strategy, then the opt-in cloud fallbacks. Returns the patched content (the
 * original when nothing was usable) and whether the file failed.
 */
export async function generateFilePatch(ctx: FilePatchContext): Promise<{ patchedContent: string; failed: boolean }> {
  const { input, result, relPath, fullPath, workspaceRoot, sessionId, run, resolvedModel, originalContent, activeGoal, loadedTasks, nextPendingTask, changeFiles, runContents, editedInRun } = ctx;
  let patchedContent = originalContent;
  let failed = false;
    let appliedPatch = false;
    let lastFailureReason: string | undefined;

    // Compose DAG task context string if tasks exist
    const tasksContext = loadedTasks
      ? `Active Task: [${nextPendingTask?.id || 'adhoc'}] ${activeGoal}\nOverall Plan:\n` +
        loadedTasks.map(t => `- [${t.status === 'completed' ? 'x' : (t.status === 'in_progress' ? '~' : ' ')}] ${t.task}`).join('\n')
      : undefined;

    const crossContext = changeFiles.length > 1 ? crossFileContext(relPath, changeFiles, runContents, editedInRun) : '';
    const goalForFile = crossContext ? `${activeGoal}\n\n${crossContext}` : activeGoal;
    const baseInstruction = tasksContext
      ? `${goalForFile}\n\n[DAG Context]\n${tasksContext}`
      : goalForFile;
    // The tests the verifyCommand runs are the specification: show them (read-only).
    const testContext = input.verifyCommand ? await readVerifyTestContext(input.verifyCommand, workspaceRoot) : '';
    const endOfFileHint = isEndOfFileInstruction(activeGoal) ? ' To add code at the end of the file, leave the SEARCH part empty and put the new code in REPLACE.' : '';
    const augmentedInstruction = testContext ? `${baseInstruction}${endOfFileHint}\n\n${testContext}` : baseInstruction + endOfFileHint;

    // Try SEARCH/REPLACE first, local model then cloud — see
    // generateSearchReplacePatch: unchanged content never passes through
    // the model, so it can't be collapsed/duplicated/hallucinated the
    // way full-file or windowed-splice replies can. Only fall through to
    // those older (guarded, but strictly weaker) strategies if no block
    // parses or every block fails to match — e.g. the model ignores the
    // requested format entirely.
    // rewrite mode (set by the repair loop) skips patching for small files and regenerates them.
    const rewriteSmallFile = !!input.rewrite && patchedContent.split(/\r?\n/).length <= 200;
    // The repair loop escalates to the cloud model when the local one keeps repeating a wrong edit (#106).
    const cloudFirst = !!input.preferCloud && (input.allowCloudFallback ?? loadCodingAgentsSettings(workspaceRoot).allowCloudFallback);
    const localModel = cloudFirst ? null : resolvedModel;
    if (cloudFirst) caTrace('cloud first (escalated by the repair loop)', relPath);
    if (localModel && !rewriteSmallFile) {
      try {
        // Routed through localLlmPatch (not a direct chatLocal call) so
        // this shares the exact same model-invocation, context-gathering,
        // and refusal-detection code as the full-content path below —
        // including the same test/mock seam.
        const lineCount = patchedContent.split(/\r?\n/).length;
        const windowInfo = lineCount > 150 ? extractWindowForInstruction(patchedContent, augmentedInstruction, 150) : null;
        // One informed retry: a SEARCH/REPLACE call costs ~5 s; the fallback below regenerates the
        // file (~125 s for 600 lines on a 7B, traced live) and is riskier. Tell the model why its
        // first reply could not be used and ask again in the same format.
        for (let srTry = 0; srTry < 2 && !appliedPatch; srTry++) {
        caTrace('local search-replace', `${relPath}${srTry ? ' (retry)' : ''}`);
        const srInstruction = srTry === 0 ? augmentedInstruction : `${augmentedInstruction}\n\nYour previous SEARCH/REPLACE reply could not be used: ${lastFailureReason}. Reply again with corrected SEARCH/REPLACE blocks: copy every SEARCH line exactly from the excerpt, and put new imports with the other imports at the top of the file.`;
        const srLlmResult = await localLlmPatch({
          filePath: fullPath,
          instruction: srInstruction,
          workspace_root: workspaceRoot,
          sessionId,
          temperature: input.temperature,
          ...(input.model && resolvedModel ? { model: resolvedModel } : {}),
          ...(input.think ? { think: input.think } : {}),
          ...(run ? { signal: run.controller.signal } : {}),
          outputFormat: 'search-replace',
          contentOverride: windowInfo ? windowInfo.window : patchedContent,
          excerptRange: windowInfo
            ? { startLine: windowInfo.startIdx + 1, endLine: windowInfo.endIdx, totalLines: windowInfo.lineCount }
            : undefined,
        });
        if (srLlmResult.success && srLlmResult.patch?.trim()) {
          const { blocks, incomplete } = parseSearchReplaceBlocksDetailed(srLlmResult.patch);
          if (blocks.length === 0) {
            lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: no ${incomplete ? 'complete ' : ''}blocks found in response${incomplete ? ' (the reply ended inside a block)' : ''}`;
          } else {
            // Apply against the FULL current content by exact text match —
            // independent of whatever window was shown to the model, so
            // there's no line-offset bookkeeping to get wrong.
            const { content, appliedCount, failures } = applySearchReplaceBlocks(patchedContent, blocks, { additive: isAdditiveInstruction(activeGoal), allowAppend: isEndOfFileInstruction(activeGoal) });
            if (incomplete > 0) failures.push(`${incomplete} block(s) were cut off before the REPLACE marker and were not applied`);
            const regressed = appliedCount > 0 && await searchReplaceRegressesTsErrors(relPath, patchedContent, content);
            // New imports must resolve in the REAL workspace (the in-memory TS gate ignores unresolved modules).
            const importProblems = appliedCount > 0 && !regressed ? await newImportProblems(relPath, patchedContent, content, workspaceRoot) : [];
            // A second definition of an existing name (the later one wins) is never what the edit meant.
            const duplicateDefs = appliedCount > 0 && !regressed ? newDuplicateDefinitions(relPath, patchedContent, content) : [];
            if (appliedCount > 0 && !regressed && importProblems.length === 0 && duplicateDefs.length === 0) {
              patchedContent = content;
              result.modelUsed = localModel;
              result.usedFallbackModel = false;
              appliedPatch = true;
              if (failures.length > 0) {
                result.diagnostics.push({
                  filePath: relPath,
                  message: `Local model (${resolvedModel}) SEARCH/REPLACE: ${appliedCount} block(s) applied, ${failures.length} skipped: ${failures.join('; ')}`,
                  severity: 'warning',
                  source: 'llm-patch',
                });
              }
            } else if (duplicateDefs.length > 0) {
              lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: ${duplicateDefs.join('; ')}`;
            } else if (importProblems.length > 0) {
              lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: the edit adds an import that does not resolve: ${importProblems.join('; ')}`;
            } else if (regressed) {
              lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: ${appliedCount} block(s) matched, but applying them increases the file's compiler error count — rejected atomically (partial async/signature migrations are worse than no change)`;
            } else {
              lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: no blocks applied (${failures.join('; ') || 'unknown reason'})`;
            }
          }
        } else if (srLlmResult.error) {
          lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: ${srLlmResult.error}`;
        }
        }
      } catch (srErr: any) {
        lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE failed: ${srErr.message}`;
      }
    }

    // Fall back to the older full-file / windowed-splice strategy —
    // weaker (relies on post-hoc corruption guards rather than making
    // corruption structurally impossible) but kept as a second attempt
    // in case the model can't/won't follow the SEARCH/REPLACE format.
    // The corruption guard runs on ITS result immediately — not after
    // the fact — because a local "success" that's actually a
    // hallucinated replacement must NOT skip the cloud fallback below
    // the way a genuine success would. Without this, a local model that
    // reliably produces garbage (rather than erroring) would set
    // appliedPatch=true and permanently starve cloud fallback of ever
    // being tried, forcing identical failures on every manual resume
    // retry instead of auto-escalating within one call.
    // A large module is not regenerated whole after SEARCH/REPLACE failed twice: that is the slowest
    // path (minutes on a 7B) and the one that drops or renames code. The repair loop retries instead.
    const skipWholeFileRegen = !!localModel && !rewriteSmallFile && !appliedPatch
      && patchedContent.split(/\r?\n/).length > 300 && /^\s*export\s+/m.test(patchedContent);
    if (skipWholeFileRegen) caTrace('whole-file regeneration skipped (large module)', relPath);
    if (localModel && !appliedPatch && !skipWholeFileRegen) {
      // Visible record that SEARCH/REPLACE failed and the pipeline is
      // dropping to a strategy that can't structurally prevent scope
      // drift — observed live: SR failed here (a vision-language model
      // wrongly entered the candidate pool, see rankCandidateModels),
      // full-file regen "fixed" the reported compile errors but also
      // silently renamed/deleted methods the goal never asked to touch.
      // The corruption guards below catch wholesale hallucination, not
      // this — a real, syntactically valid, but scope-violating rewrite.
      // Folded into lastFailureReason (rather than a separate diagnostic
      // entry) so it surfaces in the single final diagnostic if this
      // fallback also fails, matching this function's existing
      // localReason-chaining style instead of adding a second entry.
      const srFailureNote = lastFailureReason;
      caTrace('search-replace not used', String(srFailureNote ?? '').slice(0, 400));
      lastFailureReason = undefined;
      try {
        // Same sliding-window fix already used for the cloud fallback below:
        // asking a local model to reproduce a large non-module file (HTML,
        // classic browser JS with no `export`s) in full is what causes
        // truncation/hallucination. Locate the ~120-line region the
        // instruction actually targets and send only that; local_llm_patch
        // splices nothing itself, so the excerpt is spliced back here,
        // right before the corruption guard runs on the reconstructed
        // full content — matching the cloud path's guard timing exactly.
        const hasExports = /^\s*export\s+/m.test(patchedContent);
        const windowInfo = !hasExports ? extractWindowForInstruction(patchedContent, activeGoal) : null;
        caTrace('local full/window patch', relPath);
        const llmResult = await localLlmPatch({
          filePath: fullPath,
          instruction: augmentedInstruction,
          workspace_root: workspaceRoot,
          sessionId,
          temperature: input.temperature,
          ...(input.model && resolvedModel ? { model: resolvedModel } : {}),
          ...(input.think ? { think: input.think } : {}),
          ...(run ? { signal: run.controller.signal } : {}),
          contentOverride: windowInfo ? windowInfo.window : undefined,
          excerptRange: windowInfo
            ? { startLine: windowInfo.startIdx + 1, endLine: windowInfo.endIdx, totalLines: windowInfo.lineCount }
            : undefined,
        });
        if (llmResult.success && llmResult.patch?.trim()) {
          const replyLines = llmResult.patch.split(/\r?\n/);
          const fullLines = patchedContent.split(/\r?\n/);
          const originalWindowLines = windowInfo ? fullLines.slice(windowInfo.startIdx, windowInfo.endIdx) : [];
          const windowMangled = windowInfo && windowReplyIsSuspicious(originalWindowLines, replyLines);
          const candidatePatch = windowInfo
            ? [
                ...fullLines.slice(0, windowInfo.startIdx),
                ...replyLines,
                ...fullLines.slice(windowInfo.endIdx),
              ].join('\n')
            : llmResult.patch;
          if (windowMangled) {
            lastFailureReason = `Local model (${resolvedModel}) mangled a ${originalWindowLines.length}-line excerpt instead of reproducing it verbatim (duplicated/dropped/reordered lines) — not used`;
          } else if (originalContent && looksLikeHallucinatedReplacement(originalContent, candidatePatch)) {
            lastFailureReason = `Local model (${resolvedModel}) produced a full-file replacement with no trace of the original file's content — likely hallucinated, not used`;
          } else {
            patchedContent = candidatePatch;
            result.modelUsed = localModel;
            result.usedFallbackModel = false;
            appliedPatch = true;
          }
        } else if (llmResult.error) {
          lastFailureReason = `Local model (${resolvedModel}) failed: ${llmResult.error}`;
        }
      } catch (llmErr: any) {
        lastFailureReason = `Local model (${resolvedModel}) failed: ${llmErr.message}`;
        console.warn(`[coding-agents] ${lastFailureReason}`);
      }
      if (!appliedPatch && srFailureNote) {
        lastFailureReason = `SEARCH/REPLACE attempt failed (${srFailureNote}); full-file fallback also failed: ${lastFailureReason || 'unknown reason'}`;
      }
    }

    // Cloud fallback sends this file and the goal to a third-party provider, so it is opt-in
    // (allowCloudFallback on the call, or in .free-llm-mcp/coding-agents.json). Off: say so and stop.
    const cloudAllowed = input.allowCloudFallback ?? loadCodingAgentsSettings(workspaceRoot).allowCloudFallback;
    if (!appliedPatch && !cloudAllowed) {
      lastFailureReason = `${lastFailureReason ?? 'The local model produced no usable edit'} (cloud fallback is off, so nothing was sent to a cloud model; set allowCloudFallback: true on the call or in ${SETTINGS_FILE} to allow it)`;
    }

    // If local model was unavailable, errored, or produced a hallucinated
    // result, fall back to cloud model — same guard applied to its output.
    if (!appliedPatch && cloudAllowed) {
      const localReason = lastFailureReason;

      // Same SEARCH/REPLACE attempt as the local model above, tried
      // first on cloud too, before falling back to full-file/windowed
      // generation — a stronger cloud model is more likely to follow
      // the format correctly, and success here is unconditionally safe
      // (unchanged content never passed through the model).
      try {
        const { useFreeLLM } = await import('../use-free-llm.js');
        caTrace('cloud search-replace fallback', relPath);
        const srResult = await generateSearchReplacePatch(
          patchedContent,
          activeGoal,
          relPath,
          tasksContext,
          async (prompt) => {
            const res = await useFreeLLM({
              messages: [
                { role: 'system', content: 'You are a precise code-editing assistant. Reply with ONLY the requested SEARCH/REPLACE blocks.' },
                { role: 'user', content: prompt },
              ],
              keywords: ['coding', 'qwen', 'deepseek', 'codellama', 'coder'],
              taskType: 'coding',
              workspace_root: workspaceRoot,
              sessionId,
              isOnePass: true,
              skipIndexing: true,
            });
            const reply = res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
            caTraceDump('cloud-sr-' + relPath, reply);
            return reply;
          }
        );
        const cloudRegressed = srResult.appliedCount > 0
          && await searchReplaceRegressesTsErrors(relPath, patchedContent, srResult.content);
        if (srResult.appliedCount > 0 && !cloudRegressed) {
          patchedContent = srResult.content;
          result.modelUsed = 'cloud-free-llm';
          result.usedFallbackModel = true;
          appliedPatch = true;
          if (srResult.failures.length > 0) {
            result.diagnostics.push({
              filePath: relPath,
              message: `Cloud model SEARCH/REPLACE: ${srResult.appliedCount} block(s) applied, ${srResult.failures.length} skipped: ${srResult.failures.join('; ')}`,
              severity: 'warning',
              source: 'llm-patch',
            });
          }
        } else if (cloudRegressed) {
          lastFailureReason = `Cloud model SEARCH/REPLACE: ${srResult.appliedCount} block(s) matched, but applying them increases the file's compiler error count — rejected atomically`;
        }
      } catch {
        // Fall through to the older cloud strategy below regardless of why.
      }
    }

    if (!appliedPatch && cloudAllowed) {
      const localReason = lastFailureReason;
      caTrace('cloud full-file fallback', relPath);
      const { patch: cloudPatch, failureReason } = await generateCodePatchWithCloudLLM(
        fullPath,
        activeGoal,
        patchedContent,
        workspaceRoot,
        sessionId,
        tasksContext
      );
      caTraceDump('cloud-full-' + relPath, cloudPatch ?? '');
      if (cloudPatch?.trim() && originalContent && looksLikeHallucinatedReplacement(originalContent, cloudPatch)) {
        lastFailureReason = `${localReason ? `${localReason} ` : ''}Cloud fallback also produced a full-file replacement with no trace of the original file's content — likely hallucinated, not used`;
      } else if (cloudPatch?.trim()) {
        patchedContent = cloudPatch;
        result.modelUsed = 'cloud-free-llm';
        result.usedFallbackModel = true;
        appliedPatch = true;
      } else {
        // If local model specifically failed/refused, surface that primary reason
        lastFailureReason = localReason
          ? `${localReason} (Cloud fallback also failed: ${failureReason || 'no response'})`
          : (failureReason || 'No valid code patch produced by LLM');
      }
    }

    if (!appliedPatch && lastFailureReason) {
      failed = true;
      result.diagnostics.push({
        filePath: relPath,
        message: `${lastFailureReason}. You can continue by re-running coding_agents with action: "resume" or providing astEditOps.`,
        severity: 'error',
        source: 'llm-patch',
      });
    }
  return { patchedContent, failed };
}
