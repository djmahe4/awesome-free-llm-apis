import path from 'node:path';
import fs from 'fs-extra';
import { VectorStore, DocumentNode } from '../../memory/VectorStore.js';
import { logToolCall } from '../../utils/ChatLogger.js';
import { localLlmPatch } from '../local-llm-patch.js';
import { RunRegistry, RunInfo } from '../../pipeline/middlewares/RunRegistry.js';
import { globalCasStore } from '../../memory/ContentAddressableCheckpoint.js';
import { assertPatchPathAllowed } from '../../harness/write-guard.js';
import {
  type SnapshotAnchor,
  type LineAnchoredPatch,
  type DiagnosticResult,
  type TaskItem,
  type CodingAgentsInput,
  type CodingAgentsResult,
  formatCodingAgentsMarkdown,
} from './types.js';
import { computeTag, applyStructuralRewrite } from './rewrite.js';
import { generateUnifiedDiff, assertSafe } from './diff.js';
import { runTsMorphCheck, extractTsMorphSymbols } from './diagnostics.js';
import { dispatchLspDiagnostics } from './lsp-actions.js';
import {
  decomposeGoalIntelligently,
  serializeTasksMarkdown,
  parseTasksMarkdown,
  extractGoalFromTasksMarkdown,
} from './tasks.js';
import {
  extractWindowForInstruction,
  parseSearchReplaceBlocksDetailed,
  applySearchReplaceBlocks,
  isAdditiveInstruction,
  isNoopPatch,
  searchReplaceRegressesTsErrors,
  looksLikeHallucinatedReplacement,
  generateSearchReplacePatch,
  generateCodePatchWithCloudLLM,
  windowReplyIsSuspicious,
} from './patch-gen.js';
import {
  discoverWiringTargets,
  scanCodeFiles,
  withMarkdown,
  stableWorkspaceSessionId,
  aliasServesCall,
  sessionAliases,
  codingAgentsResultsCache,
} from './session-wiring.js';

export async function CodingAgentsHandler(input: CodingAgentsInput): Promise<CodingAgentsResult> {
  const resolvedRoot = path.resolve(input.workspaceRoot || process.cwd());
  const derived = stableWorkspaceSessionId(input.workspaceRoot);
  sessionAliases.set(derived, { root: resolvedRoot, canonical: derived });
  let sessionId = derived;
  if (input.sessionId && input.sessionId !== derived) {
    const alias = sessionAliases.get(input.sessionId);
    if (aliasServesCall(alias, input, resolvedRoot)) sessionId = alias.canonical;
    else if (!alias) sessionAliases.set(input.sessionId, { root: resolvedRoot, canonical: derived });
  }
  const runKey = `coding_agents:${sessionId}`;

  if (input.action === 'status') {
    const run = RunRegistry.get(runKey);
    if (!run) {
      return withMarkdown({
        sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
        patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
        error: `No run found for sessionId '${sessionId}'. Call with action:"execute" (dryRun:false) first.`,
      });
    }
    if (!run.done) {
      return withMarkdown({
        sessionId, goal: input.goal, pipelineStage: 'edit', relevantFiles: [], anchors: [],
        patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
        status: 'running',
        message: `Running: ${run.completedCount}/${run.totalCount} file(s) (last: ${run.lastSubtask || 'n/a'})`,
      });
    }
    return codingAgentsResultsCache.get(runKey) || withMarkdown({
      sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
      patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
      error: 'Run finished but no cached result was found.',
    });
  }

  if (input.action === 'abort') {
    const aborted = RunRegistry.abort(runKey);
    return withMarkdown({
      sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
      patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
      status: 'running',
      message: aborted ? 'Abort requested; in-flight file patching will stop after its current file.' : `No active run found for sessionId '${sessionId}' to abort.`,
    });
  }

  const dryRun = input.dryRun !== false; // same default as the pipeline itself
  const isRollback = input.resolve?.action === 'rollback';
  // Per-file undo / history reads are deterministic disk operations — like
  // rollback they must run synchronously, never be backgrounded behind RunRegistry.
  const isFileHistoryOp = input.resolve?.action === 'undo_file' || input.resolve?.action === 'file_history';
  const isPlanOnly = input.action === 'plan' || input.pauseOnTaskPlan;
  // astEditOps-only edits are deterministic structural rewrites — the pipeline itself
  // skips LLM generation entirely for them (see the `!input.astEditOps` guard in Step 4),
  // so there's nothing slow here to background.
  const isAstOnly = !!input.astEditOps && input.astEditOps.length > 0;

  // Fast, synchronous paths: preview, plan creation, rollback, per-file undo/history, deterministic AST edits — unchanged behavior.
  if (dryRun || isRollback || isFileHistoryOp || isPlanOnly || isAstOnly) {
    return runCodingAgentsPipeline(input, sessionId);
  }

  // Real execution: background it so a slow local-model generation over a large
  // prompt can't be mistaken for a hang by the caller's own tool-call timeout.
  const existingRun = RunRegistry.get(runKey);
  if (existingRun && !existingRun.done) {
    return withMarkdown({
      sessionId, goal: input.goal, pipelineStage: 'edit', relevantFiles: [], anchors: [],
      patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
      status: 'running',
      message: `Already running: ${existingRun.completedCount}/${existingRun.totalCount} file(s). Poll with action:"status" and the same sessionId.`,
    });
  }

  const run = RunRegistry.start(runKey);
  (async () => {
    try {
      const result = await runCodingAgentsPipeline(input, sessionId, run);
      codingAgentsResultsCache.set(runKey, result);
      RunRegistry.finish(runKey, result.error);
    } catch (err: any) {
      codingAgentsResultsCache.set(runKey, withMarkdown({
        sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
        patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
        error: err?.message || String(err),
      }));
      RunRegistry.finish(runKey, err?.message || String(err));
    }
  })();

  return withMarkdown({
    sessionId, goal: input.goal, pipelineStage: 'edit', relevantFiles: [], anchors: [],
    patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
    status: 'running',
    message: `Started coding_agents execution in the background. Poll with action:"status" and the same sessionId.`,
  });
}

async function runCodingAgentsPipeline(input: CodingAgentsInput, sessionId: string, run?: RunInfo): Promise<CodingAgentsResult> {
  const start = Date.now();
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd());
  const dryRun = input.dryRun !== false; // safe default: true
  const topK = input.topKFiles || 5;

  let result: CodingAgentsResult = {
    sessionId,
    goal: input.goal,
    pipelineStage: 'enumerate',
    relevantFiles: [],
    anchors: [],
    patchPlan: [],
    patchSummary: '',
    diagnostics: [],
    applied: false,
  };

  const finalizeResult = async (): Promise<CodingAgentsResult> => {
    if (result.status !== 'paused' && result.status !== 'undo_file' && result.status !== 'file_history') {
      result.status = (result.restoredFiles && result.restoredFiles.length > 0)
        ? 'rollback'
        : (result.applied ? 'applied' : 'dry_run');
    }
    result.content = formatCodingAgentsMarkdown(result);
    result.markdown = result.content;
    await logToolCall(sessionId, 'coding_agents', input, result, Date.now() - start, !!result.error).catch(() => {});
    return result;
  };

  try {
    // ── Handle Rollback Action ───────────────────────────────────────────────
    if (input.resolve?.action === 'rollback') {
      const targetCheckpoint = input.resolve.checkpointId ||
        globalCasStore.listSessionCheckpoints(sessionId).pop()?.checkpointId;

      if (!targetCheckpoint) {
        throw new Error(`No CAS checkpoint found for session '${sessionId}' to rollback to.`);
      }

      const { restoredCount, files } = await globalCasStore.restoreCheckpointToDisk(
        targetCheckpoint,
        workspaceRoot
      );

      result.pipelineStage = 'completed';
      result.applied = true;
      result.status = 'rollback';
      result.checkpointId = targetCheckpoint;
      result.restoredFiles = files;
      result.patchSummary = `Rolled back ${restoredCount} file(s) from CAS checkpoint ${targetCheckpoint}`;
      return result;
    }

    // ── Handle Per-File Undo / History Actions (R1) ─────────────────────────
    if (input.resolve?.action === 'undo_file' || input.resolve?.action === 'file_history') {
      const filePath = input.resolve.filePath;
      if (!filePath) throw new Error(`${input.resolve.action} requires resolve.filePath.`);

      if (input.resolve.action === 'file_history') {
        const versions = globalCasStore.fileHistoryVersions(workspaceRoot, filePath);
        result.pipelineStage = 'completed';
        result.applied = false;
        result.status = 'file_history';
        result.fileHistory = versions;
        result.patchSummary = `File history for ${filePath}: ${versions.length} version(s), newest first (null = file did not exist before that apply)`;
        return finalizeResult();
      }

      const { restored, remainingDepth } = await globalCasStore.undoFileVersionToDisk(workspaceRoot, filePath);
      // R2: the pop changed fileHistory — persist it so the undo doesn't
      // silently reappear after a restart. Best-effort, same as apply flush.
      await globalCasStore.flushCasToDisk().catch(() => { /* in-memory still authoritative */ });
      result.pipelineStage = 'completed';
      result.applied = true;
      result.status = 'undo_file';
      result.restored = restored;
      result.remainingDepth = remainingDepth;
      result.patchSummary = `Restored previous version of ${filePath}; ${remainingDepth} version(s) left in its undo history`;
      return finalizeResult();
    }

    if (!input.goal) throw new Error('Goal is required for coding_agents planning');

    const tasksFilePath = path.join(workspaceRoot, 'tasks.md');

    // ── Handle Action: 'plan' or pauseOnTaskPlan ─────────────────────────────
    if (input.action === 'plan' || input.pauseOnTaskPlan) {
      const planCandidateFiles = await scanCodeFiles(workspaceRoot, 100);
      const tasks = await decomposeGoalIntelligently(input.goal, workspaceRoot, planCandidateFiles, sessionId);
      await fs.writeFile(tasksFilePath, serializeTasksMarkdown(input.goal, tasks), 'utf-8');
      result.pipelineStage = 'completed';
      result.tasksPlan = tasks;
      result.tasksFile = 'tasks.md';
      result.isPaused = true;
      result.status = 'paused';
      result.patchSummary = `Created tasks.md with ${tasks.length} task(s) and paused. Call with action="resume" to proceed.`;
      result.content = formatCodingAgentsMarkdown(result);
      result.markdown = result.content;
      return result;
    }

    let activeGoal = input.goal;
    let loadedTasks: TaskItem[] | undefined;
    let nextPendingTask: TaskItem | undefined;
    let planGoal = input.goal;
    let taskResumeCount = 0;

    // ── Handle Action: 'resume' ──────────────────────────────────────────────
    if (input.action === 'resume') {
      if (await fs.pathExists(tasksFilePath)) {
        const tasksContent = await fs.readFile(tasksFilePath, 'utf-8');
        loadedTasks = parseTasksMarkdown(tasksContent);
        planGoal = extractGoalFromTasksMarkdown(tasksContent) || input.goal;
        nextPendingTask = loadedTasks.find(t => t.status === 'pending');
        if (nextPendingTask) {
          taskResumeCount = (nextPendingTask.log?.length || 0) + 1;
          nextPendingTask.status = 'in_progress';
          // Blackboard: fold the planner's own context (why this file, what
          // not to break, cross-task dependencies) into what local_llm_patch
          // actually sees, not just the bare task string.
          activeGoal = nextPendingTask.context
            ? `${nextPendingTask.task}\n\n[Planner context]\n${nextPendingTask.context}`
            : nextPendingTask.task;
        }
      }
    }

    // A planner-assigned targetFile scopes this resume to that one file, same
    // as an explicit input.targetFiles — but input.targetFiles (if the caller
    // passed one) always wins.
    const effectiveTargetFiles = (input.targetFiles && input.targetFiles.length > 0)
      ? input.targetFiles
      : (nextPendingTask?.targetFile ? [nextPendingTask.targetFile] : undefined);

    // ── Step 1: Enumerate ────────────────────────────────────────────────────
    const codeFiles: string[] = await scanCodeFiles(workspaceRoot, 100);

    // ── Step 2: Locate (VectorStore RAG) ────────────────────────────────────
    result.pipelineStage = 'locate';
    const store = new VectorStore();
    const docNodes: DocumentNode[] = [];

    for (const relPath of codeFiles) {
      try {
        const fullPath = path.resolve(workspaceRoot, relPath);
        if (await fs.pathExists(fullPath)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          docNodes.push({ id: relPath, text: content });
        }
      } catch { /* Skip unreadable files */ }
    }

    if (effectiveTargetFiles && effectiveTargetFiles.length > 0) {
      result.relevantFiles = effectiveTargetFiles.map(f => path.normalize(f).replace(/\\/g, '/'));
    } else {
      await store.index(docNodes);
      const searchMatches = await store.query(activeGoal, topK);
      const matchedPaths = searchMatches.map(m => m.id);
      result.relevantFiles = matchedPaths.length > 0 ? matchedPaths : codeFiles.slice(0, topK);
    }

    // ── Step 2b: Automatic Wiring Discovery for New Files ────────────────────
    const discoveredWiring: string[] = [];
    const wiringSnippets: string[] = [];

    for (const relPath of result.relevantFiles) {
      const fullPath = path.resolve(workspaceRoot, relPath);
      if (!(await fs.pathExists(fullPath))) {
        const { wiringFiles, snippets } = await discoverWiringTargets(relPath, workspaceRoot, sessionId);
        discoveredWiring.push(...wiringFiles);
        wiringSnippets.push(...snippets);
      }
    }

    if (discoveredWiring.length > 0) {
      result.wiringFiles = Array.from(new Set(discoveredWiring));
      result.wiringContext = wiringSnippets;
    }

    // ── Step 3: Anchor [PATH#SHA8] ───────────────────────────────────────────
    result.pipelineStage = 'anchor';
    const anchors: SnapshotAnchor[] = [];
    const patches: LineAnchoredPatch[] = [];
    // Appended after the verification diagnostics so existing consumers still see those first.
    const noopWarnings: DiagnosticResult[] = [];
    let noopFiles = 0;

    // Hoist model resolution — avoid N×listLocalModels HTTP calls (one per file)
    let resolvedModel: string | null = null;
    if (!dryRun) {
      try {
        const { listLocalModels, rankCandidateModels } = await import('../../providers/ollama-local.js');
        const models = await listLocalModels();

        // Check llmfit hardware recommendations to find the optimal coding model
        try {
          const { recommendModels } = await import('../../services/llmfit.js');
          const fitResult = await recommendModels({ useCase: 'coding', limit: 5, workspaceRoot });
          const recommendedOllamaNames = (fitResult.models || [])
            .map(m => m.ollamaName)
            .filter(Boolean) as string[];

          for (const rec of recommendedOllamaNames) {
            const match = models.find(m => m === rec || m.startsWith(`${rec}:`));
            if (match) {
              resolvedModel = match;
              break;
            }
          }
        } catch {
          // Fall back gracefully to heuristic candidate ranking
        }

        if (!resolvedModel) {
          const ranked = rankCandidateModels(models);
          resolvedModel = ranked[0] ?? null;
        }
      } catch {
        console.warn('[coding-agents] Ollama unreachable — will route to cloud model fallback');
      }
    }

    // ── Step 4: Edit (AST rewrites + LLM generation) ─────────────────────────
    result.pipelineStage = 'edit';
    if (run) run.totalCount = result.relevantFiles.length;
    // Blackboard tracking: did any file in this resume fail to produce a real
    // patch (LLM generation failure or hallucinated-replacement guard)? Used
    // to decide whether the task actually completed or should stay pending
    // for another resume attempt.
    let taskHadFailure = false;

    for (const relPath of result.relevantFiles) {
      if (run?.controller.signal.aborted) break;
      if (run) RunRegistry.progress(`coding_agents:${sessionId}`, relPath, run.completedCount, run.totalCount);
      const fullPath = path.resolve(workspaceRoot, relPath);
      assertSafe(fullPath, workspaceRoot); // security: block path traversal
      assertPatchPathAllowed(workspaceRoot, relPath); // security: block protected harness configs and bridges.json

      const fileExists = await fs.pathExists(fullPath);
      const originalContent = fileExists ? await fs.readFile(fullPath, 'utf-8') : '';
      const lines = originalContent ? originalContent.split(/\r?\n/) : [];
      const tag = computeTag(originalContent);
      const hashTag = `[${relPath}#${tag}]`;

      anchors.push({
        filePath: relPath,
        hashTag,
        lineCount: lines.length,
        capturedAt: Date.now(),
      });

      let patchedContent = originalContent;
      let rewrites = 0;

      // 4a. LLM generation via localLlmPatch with seamless cloud fallback
      if (!dryRun && (!input.astEditOps || input.astEditOps.length === 0)) {
        let appliedPatch = false;
        let lastFailureReason: string | undefined;

        // Compose DAG task context string if tasks exist
        const tasksContext = loadedTasks
          ? `Active Task: [${nextPendingTask?.id || 'adhoc'}] ${activeGoal}\nOverall Plan:\n` +
            loadedTasks.map(t => `- [${t.status === 'completed' ? 'x' : (t.status === 'in_progress' ? '~' : ' ')}] ${t.task}`).join('\n')
          : undefined;

        const augmentedInstruction = tasksContext
          ? `${activeGoal}\n\n[DAG Context]\n${tasksContext}`
          : activeGoal;

        // Try SEARCH/REPLACE first, local model then cloud — see
        // generateSearchReplacePatch: unchanged content never passes through
        // the model, so it can't be collapsed/duplicated/hallucinated the
        // way full-file or windowed-splice replies can. Only fall through to
        // those older (guarded, but strictly weaker) strategies if no block
        // parses or every block fails to match — e.g. the model ignores the
        // requested format entirely.
        if (resolvedModel) {
          try {
            // Routed through localLlmPatch (not a direct chatLocal call) so
            // this shares the exact same model-invocation, context-gathering,
            // and refusal-detection code as the full-content path below —
            // including the same test/mock seam.
            const lineCount = patchedContent.split(/\r?\n/).length;
            const windowInfo = lineCount > 150 ? extractWindowForInstruction(patchedContent, augmentedInstruction, 150) : null;
            const srLlmResult = await localLlmPatch({
              filePath: fullPath,
              instruction: augmentedInstruction,
              workspace_root: workspaceRoot,
              sessionId,
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
                const { content, appliedCount, failures } = applySearchReplaceBlocks(patchedContent, blocks, { additive: isAdditiveInstruction(activeGoal) });
                if (incomplete > 0) failures.push(`${incomplete} block(s) were cut off before the REPLACE marker and were not applied`);
                const regressed = appliedCount > 0 && await searchReplaceRegressesTsErrors(relPath, patchedContent, content);
                if (appliedCount > 0 && !regressed) {
                  patchedContent = content;
                  result.modelUsed = resolvedModel;
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
                } else if (regressed) {
                  lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: ${appliedCount} block(s) matched, but applying them increases the file's compiler error count — rejected atomically (partial async/signature migrations are worse than no change)`;
                } else {
                  lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: no blocks applied (${failures.join('; ') || 'unknown reason'})`;
                }
              }
            } else if (srLlmResult.error) {
              lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: ${srLlmResult.error}`;
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
        if (resolvedModel && !appliedPatch) {
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
            const llmResult = await localLlmPatch({
              filePath: fullPath,
              instruction: augmentedInstruction,
              workspace_root: workspaceRoot,
              sessionId,
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
                result.modelUsed = resolvedModel;
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

        // If local model was unavailable, errored, or produced a hallucinated
        // result, fall back to cloud model — same guard applied to its output.
        if (!appliedPatch) {
          const localReason = lastFailureReason;

          // Same SEARCH/REPLACE attempt as the local model above, tried
          // first on cloud too, before falling back to full-file/windowed
          // generation — a stronger cloud model is more likely to follow
          // the format correctly, and success here is unconditionally safe
          // (unchanged content never passed through the model).
          try {
            const { useFreeLLM } = await import('../use-free-llm.js');
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
                return res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
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

        if (!appliedPatch) {
          const localReason = lastFailureReason;
          const { patch: cloudPatch, failureReason } = await generateCodePatchWithCloudLLM(
            fullPath,
            activeGoal,
            patchedContent,
            workspaceRoot,
            sessionId,
            tasksContext
          );
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
          taskHadFailure = true;
          result.diagnostics.push({
            filePath: relPath,
            message: `${lastFailureReason}. You can continue by re-running coding_agents with action: "resume" or providing astEditOps.`,
            severity: 'error',
            source: 'llm-patch',
          });
        }
      }

      // 4b. Structural AST rewrites (OMP-style $$$VAR patterns)
      if (input.astEditOps && input.astEditOps.length > 0) {
        for (const op of input.astEditOps) {
          const { content: rewritten, matchCount } = await applyStructuralRewrite(fullPath, patchedContent, op.pat, op.out);
          if (matchCount > 0) {
            patchedContent = rewritten;
            rewrites += matchCount;
          } else {
            // Validate AST edits: flag zero-match as diagnostic warning
            result.diagnostics.push({
              filePath: relPath,
              message: `AST pattern "${op.pat}" matched 0 occurrences in ${relPath}`,
              severity: 'warning',
              source: 'ast-syntactic',
            });
          }
        }
        // A zero-match astEditOps call is a no-op, not a success — the file
        // is unchanged, but this only ever surfaced as a 'warning' diagnostic,
        // which taskHadFailure doesn't check (only 'error'/'llm-patch' does).
        // Without this, a DAG task resumed with a pattern that doesn't match
        // gets marked 'completed' on the blackboard despite accomplishing
        // nothing, and the DAG moves on instead of retrying with a corrected
        // pattern.
        if (rewrites === 0) {
          taskHadFailure = true;
        }
      }

      const replacementLines = patchedContent ? patchedContent.split(/\r?\n/) : [];
      const { unifiedDiff, origSnippet, replSnippet, startLine: windowStartLine } = generateUnifiedDiff(
        relPath,
        hashTag,
        lines,
        replacementLines
      );

      if (fileExists && isNoopPatch(lines, replacementLines)) {
        // Nothing to propose. This used to be listed as a "proposed" patch holding only a
        // trailing-newline artifact, which read as if the edit had been attempted and succeeded.
        noopFiles++;
        if (!dryRun) {
          noopWarnings.push({
            filePath: relPath,
            message: 'No change was produced for this file (the model returned the original text or no edit applied).',
            severity: 'warning',
            source: 'llm-patch',
          });
          taskHadFailure = true;
        }
      }
      // Still recorded (verification diagnostics run over every entry), now with the warning above.
      patches.push({
        filePath: relPath,
        anchorTag: hashTag,
        startLine: windowStartLine,
        endLine: lines.length,
        originalSnippet: origSnippet,
        replacementSnippet: replSnippet,
        fullPatchedContent: patchedContent, // full content for diagnostics & writes
        unifiedDiff,
        isNewFile: !fileExists,
      });

      result.astRewritesCount = (result.astRewritesCount || 0) + rewrites;
      if (run) {
        run.completedCount++;
        RunRegistry.progress(`coding_agents:${sessionId}`, relPath, run.completedCount, run.totalCount);
      }
    }

    // 4c. Atomic Multi-File Single Update with Zero-Waste Pre-Apply CAS Checkpointing
    if (!dryRun && input.resolve?.action === 'apply' && patches.length > 0) {
      for (const patch of patches) {
        assertPatchPathAllowed(workspaceRoot, patch.filePath);
      }
      // Step 1: Snapshot original files into CAS before modifying
      const preApplyMap: Record<string, string> = {};
      const preHistoryMap: Record<string, string | null> = {};
      for (const patch of patches) {
        const fullPath = path.resolve(workspaceRoot, patch.filePath);
        if (await fs.pathExists(fullPath)) {
          const original = await fs.readFile(fullPath, 'utf-8');
          preApplyMap[patch.filePath] = original;
          preHistoryMap[patch.filePath] = original;
        } else {
          // Brand-new file: record a null slot so undo_file can delete it (R1).
          preHistoryMap[patch.filePath] = null;
        }
      }

      // Per-file undo history (depth CAS_FILE_HISTORY_DEPTH, default 3): the
      // pre-apply versions are recorded BEFORE the transactional write so an
      // interrupted apply still leaves a consistent newest-first buffer behind.
      globalCasStore.recordFileVersions(workspaceRoot, preHistoryMap);

      const checkpoint = globalCasStore.createCheckpoint(
        sessionId,
        `Pre-apply snapshot before '${input.goal}'`,
        preApplyMap
      );
      result.checkpointId = checkpoint.checkpointId;

      // Step 2: Transactional write across all files (temp files + atomic renames)
      const tempWrites: Array<{ tmpPath: string; fullPath: string }> = [];
      try {
        for (const patch of patches) {
          const fullPath = path.resolve(workspaceRoot, patch.filePath);
          if (!patch.fullPatchedContent?.trim()) {
            throw new Error(`Refusing to write empty patch for ${patch.filePath} — content was blank`);
          }
          const tmpPath = `${fullPath}.oagent.${sessionId}.tmp`;
          await fs.ensureDir(path.dirname(fullPath));
          await fs.writeFile(tmpPath, patch.fullPatchedContent, 'utf-8');
          tempWrites.push({ tmpPath, fullPath });
        }

        // Commit all renames atomically
        for (const { tmpPath, fullPath } of tempWrites) {
          await fs.rename(tmpPath, fullPath);
        }
      } catch (writeErr: any) {
        // Rollback any temporary files on error
        for (const { tmpPath } of tempWrites) {
          try { await fs.remove(tmpPath); } catch { /* ignore */ }
        }
        throw writeErr;
      }

      // R2: persist CAS state (checkpoint manifest + per-file undo history)
      // right after the writes commit, so a restart can still rollback/undo
      // this apply. Best-effort: a failed flush must never fail the apply —
      // in-memory CAS stays authoritative for this session either way.
      await globalCasStore.flushCasToDisk().catch((flushErr: any) => {
        result.diagnostics.push({
          filePath: patches[0]?.filePath || 'unknown',
          message: `CAS disk persistence flush failed (in-memory checkpoint still valid for this session): ${flushErr?.message || flushErr}`,
          severity: 'warning',
          source: 'llm-patch',
        });
      });
    }

    result.anchors = anchors;
    result.patchPlan = patches;
    result.patchSummary = patches.map(p => p.unifiedDiff).join('\n');

    // ── Step 5: LSP Verify (OMP-style multi-language dispatcher) ─────────────
    result.pipelineStage = 'verify';
    const diagnosticsList: DiagnosticResult[] = [];

    if (input.verifyLspDiagnostics !== false || input.lspAction) {
      for (const patch of patches) {
        const fileDiags = await dispatchLspDiagnostics(patch, workspaceRoot);
        diagnosticsList.push(...fileDiags);

        // Extract symbols for TS/JS files
        if (/\.(ts|tsx|js|jsx)$/i.test(patch.filePath)) {
          patch.symbols = await extractTsMorphSymbols(patch.filePath, patch.fullPatchedContent);
        }
      }
    }

    result.diagnostics.push(...diagnosticsList, ...noopWarnings);
    if (dryRun && noopFiles > 0 && noopFiles === patches.length) {
      // dryRun:true never calls a model, so every entry is the unchanged file; say so instead of
      // letting an empty diff read as "the agent proposed nothing useful".
      result.message = 'dryRun:true only enumerates files; no model was run, so there is no proposal. Re-run with dryRun:false (then resolve:{action:"apply"}) to generate and apply an edit.';
    }
    result.pipelineStage = 'completed';
    // applied = true only when patches were actually written to disk
    result.applied = !dryRun && input.resolve?.action === 'apply';

    // Post-apply verification gate: diagnostics above were computed AFTER the
    // write already landed (Step 5 runs after Step 4c) — without this, a
    // patch with real compiler errors still stays on disk, diagnostics or not.
    // Observed live: an LLM-hallucinated full-file replacement produced 22
    // real TS errors (unresolved names, syntax errors) and was still applied.
    // A CAS checkpoint already exists for this apply — use it to roll back
    // automatically rather than leave broken code on disk.
    if (result.applied && result.checkpointId) {
      // runTsMorphCheck's per-file in-memory project has no lib.d.ts or sibling
      // modules loaded (by design — see its own comment), so semantic TS
      // diagnostics (code >= 2000: "Cannot find module", "Cannot find name
      // Buffer/path", etc.) are known, accepted noise on ANY real file with
      // relative imports or Node globals — not a corruption signal. Syntax
      // errors (code < 2000: malformed grammar) ARE reliable regardless of
      // missing project context, and non-ts-morph sources (subprocess: full
      // python/go/rustc compiles) are already trustworthy in full.
      const hasErrorDiagnostics = diagnosticsList.some(d =>
        d.severity === 'error' && !(d.source === 'ast-syntactic' && typeof d.code === 'number' && d.code >= 2000)
      );
      if (hasErrorDiagnostics) {
        taskHadFailure = true;
        try {
          const { restoredCount, files } = await globalCasStore.restoreCheckpointToDisk(result.checkpointId, workspaceRoot);
          // The CAS checkpoint only captures files that existed BEFORE this run
          // (Step 4c's preApplyMap) — it has no prior version of a brand-new
          // file to restore, so restoring it is a no-op for those. Delete them
          // directly instead, or a broken new file survives while the result
          // claims a clean rollback happened.
          const deletedNewFiles: string[] = [];
          for (const patch of patches) {
            if (patch.isNewFile) {
              const fullPath = path.resolve(workspaceRoot, patch.filePath);
              await fs.remove(fullPath).catch(() => {});
              deletedNewFiles.push(patch.filePath);
            }
          }
          result.applied = false;
          result.restoredFiles = [...files, ...deletedNewFiles];
          result.patchSummary = `Automatically rolled back ${restoredCount} file(s)${deletedNewFiles.length ? ` and removed ${deletedNewFiles.length} newly-created file(s)` : ''}: the applied patch introduced ${diagnosticsList.filter(d => d.severity === 'error').length} compiler error(s), which usually means the LLM's output doesn't actually belong to the target file. Checkpoint: ${result.checkpointId}. Re-run with a more explicit goal, astEditOps, or action:"resume".`;
        } catch (rollbackErr: any) {
          result.diagnostics.push({
            filePath: patches[0]?.filePath || 'unknown',
            message: `Applied patch introduced compiler errors AND automatic rollback failed (${rollbackErr.message}) — file(s) may be left in a broken state. Checkpoint ${result.checkpointId} is still available for manual rollback via resolve:{action:"rollback"}.`,
            severity: 'error',
            source: 'llm-patch',
          });
        }
      }
    }

    // Update tasks.md state if executing a tasks DAG. Blackboard: record what
    // actually happened this resume (not just flip a checkbox) — a failed
    // attempt stays 'pending' so the next resume retries the SAME task, with
    // this attempt's outcome visible in its log rather than silently lost.
    if (loadedTasks && nextPendingTask) {
      const succeeded = !taskHadFailure && !result.error;
      nextPendingTask.status = succeeded ? 'completed' : 'pending';
      const outcomeParts = [
        `resume#${taskResumeCount}`,
        `files=[${result.relevantFiles.join(', ')}]`,
        result.modelUsed ? `model=${result.modelUsed}` : 'model=none',
        `applied=${!!result.applied}`,
        `diagnostics=${result.diagnostics.length}`,
      ];
      if (!succeeded) {
        outcomeParts.push(result.error ? `error="${result.error}"` : 'outcome=failed (see diagnostics)');
      }
      (nextPendingTask.log ??= []).push(`${new Date().toISOString()} ${outcomeParts.join(' ')}`);

      await fs.writeFile(tasksFilePath, serializeTasksMarkdown(planGoal, loadedTasks), 'utf-8');
      result.tasksPlan = loadedTasks;
      result.tasksFile = 'tasks.md';
      const remaining = loadedTasks.filter(t => t.status === 'pending');
      if (remaining.length > 0) {
        result.isPaused = true;
        result.status = 'paused';
      }
    }

  } catch (err: any) {
    result.error = err.message || String(err);
  }

  return finalizeResult();
}
