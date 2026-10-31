// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SnapshotAnchor {
  filePath: string;
  hashTag: string; // [PATH#SHA8] e.g. "src/server.ts#a1b2c3d4"
  lineCount: number;
  capturedAt: number;
}

export interface LineAnchoredPatch {
  filePath: string;
  anchorTag: string;
  startLine: number;
  endLine: number;
  originalSnippet: string;   // preview (first 10 lines)
  replacementSnippet: string; // preview (first 10 lines)
  fullPatchedContent: string; // full content used for diagnostics & writes
  unifiedDiff: string;
  symbols?: string[];
  /** True if this file didn't exist before this run — used by the post-apply
   * rollback gate, since a CAS checkpoint only captures pre-existing content
   * and can't "restore" a file that never had a prior version. */
  isNewFile?: boolean;
}

export interface DiagnosticResult {
  filePath: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  code?: number;
  source?: 'omp-lsp' | 'ast-syntactic' | 'semantic' | 'subprocess' | 'json-syntax' | 'llm-patch' | 'verify-command' | 'hypothesis';
}

export interface LspActionRequest {
  action: 'diagnostics' | 'symbols' | 'definition' | 'references';
  file?: string;
  symbol?: string;
  query?: string;
}

export interface AstEditOp {
  /** OMP-style pattern, e.g. "console.log($$$MSG)" — single $$$ wildcard recommended */
  pat: string;
  /** Replacement, e.g. "logger.info($$$MSG)" */
  out: string;
}

export interface ResolveAction {
  action: 'apply' | 'discard' | 'rollback' | 'undo_file' | 'file_history';
  checkpointId?: string;
  reason?: string;
  /** Required for undo_file / file_history: workspace-relative file to operate on. */
  filePath?: string;
}

export interface TaskItem {
  id: string;
  task: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** File this subtask targets — set by intelligent decomposition; naive fallback leaves it unset. */
  targetFile?: string;
  /** Why this file/subtask, constraints, dependencies on other subtasks — from the planner. */
  context?: string;
  /** Blackboard: append-only record of what actually happened each time this task was resumed
   * (files touched, model used, applied outcome, diagnostic count) — the AI-agent <-> local_llm_patch
   * interaction history, not just a checkbox. */
  log?: string[];
}

export interface CodingAgentsInput {
  goal: string;
  workspaceRoot?: string;
  targetFiles?: string[];
  dryRun?: boolean;
  topKFiles?: number;
  /**
   * Optional caller-chosen alias, preserved in memory: recorded on first use
   * and accepted by every later status/abort/resume poll, even without
   * workspaceRoot. The canonical sessionId returned in results stays
   * workspace-derived (never rotates).
   */
  sessionId?: string;
  verifyLspDiagnostics?: boolean;
  lspAction?: LspActionRequest;
  astEditOps?: AstEditOp[];
  resolve?: ResolveAction;
  /**
   * Behavioural check run before and after an apply (e.g. `npx vitest run tests/a.test.ts`). A patch
   * that makes a previously passing check fail is rolled back. Allowlisted runners only, no shell
   * syntax; see tools/coding-agents/verify-command.ts.
   */
  verifyCommand?: string;
  /**
   * Output of a check the USER ran themselves (used when an edit was withheld because it touches tests,
   * scripts or hooks). A failure comes back as a debugger brief; nothing on disk changes.
   */
  verifyReport?: { exitCode: number; output: string; command?: string };
  /** Debugger brief from a previous failed attempt; appended to the goal for the retry. */
  feedback?: string;
  /** Independent candidate attempts drawn from the original file before repairing the closest one (default 3 when a verifyCommand is given; 1 disables; max 5). */
  samples?: number;
  /** Regenerate the (small) file from the requirements instead of patching it; set by the repair loop when many cases fail. */
  /** @internal set by the repair loop. */
  rewrite?: boolean;
  /** Sampling temperature for generation (default 0). The repair loop raises it on retries so a repeat is not identical. */
  temperature?: number;
  /** Files that belong to this change but are not edited in this call; their API surface is shown as reference. Set by the repair loop when it narrows a retry. */
  /** @internal set by the repair loop. */
  relatedFiles?: string[];
  /** Let a failed local edit fall back to free cloud models, which sends the file and goal to a third-party provider (default false; also settable in .free-llm-mcp/coding-agents.json). */
  allowCloudFallback?: boolean;
  /** Installed local model to use (e.g. a bigger one for a cross-file change). Overrides the automatic choice and the VRAM budget. */
  model?: string;
  /** Reasoning for thinking models: off (default), auto, on. See local_llm_patch. */
  think?: 'auto' | 'on' | 'off';
  /** Wall-clock budget for the whole repair loop in ms (default 5 minutes). */
  maxDurationMs?: number;
  /** Automatic retries after a failed check or a blocking review (default 4, max 5; AST edits never retry). */
  maxRepairAttempts?: number;
  /** Independent review of the proposed diff before apply (default on; false disables it). */
  review?: boolean;
  action?: 'plan' | 'execute' | 'resume' | 'status' | 'abort';
  pauseOnTaskPlan?: boolean;
}

export interface RepairAttempt {
  attempt: number;
  /** verification status, review_blocked, applied, proposed or error. */
  outcome: string;
  /** The brief that was fed to the next attempt (truncated). */
  brief?: string;
  /** Failing cases after this attempt (progress between attempts). */
  failing?: number;
  /** The attempt regenerated the file instead of patching it. */
  rewrite?: boolean;
}

export interface CodingAgentsResult {
  sessionId: string;
  goal: string;
  pipelineStage: 'enumerate' | 'locate' | 'anchor' | 'edit' | 'verify' | 'completed';
  relevantFiles: string[];
  anchors: SnapshotAnchor[];
  patchPlan: LineAnchoredPatch[];
  patchSummary: string;
  diagnostics: DiagnosticResult[];
  applied: boolean;
  status?: 'applied' | 'rollback' | 'dry_run' | 'paused' | 'running' | 'undo_file' | 'file_history';
  message?: string;
  checkpointId?: string;
  restoredFiles?: string[];
  /** Set when an apply was rolled back because the edit did not parse: the compiler messages as feedback for a retry. */
  rollbackBrief?: string;
  /** Independent reviewer's verdict on the proposed diff. */
  review?: {
    verdict: 'ok' | 'concerns' | 'blocked' | 'skipped';
    findings: Array<{ blocking: boolean; text: string }>;
    brief?: string;
    model?: string;
  };
  /** How the automatic repair loop ended (present when a check or review took part). */
  repair?: {
    outcome: 'converged' | 'not_converged' | 'stuck' | 'needs_user' | 'error' | 'aborted' | 'timed_out';
    attemptCount: number;
    attempts: RepairAttempt[];
  };
  /** Outcome of verifyCommand around an apply (absent when none was given or nothing was applied). */
  verification?: {
    command: string;
    /** passed | regressed (passed before, fails after: rolled back) | not_green (was failing before and still fails: test-first work, kept so the next attempt can build on it) | needs_user (edit withheld) | user_passed | user_failed */
    status?: 'passed' | 'regressed' | 'not_green' | 'needs_user' | 'user_passed' | 'user_failed';
    /** Why an edit was withheld (needs_user). */
    reasons?: string[];
    /** Debugger-persona brief built from the failing output, ready to pass back as `feedback`. */
    repairBrief?: string;
    /** The check passed after the edit. */
    ok: boolean;
    /** The check passed BEFORE the edit; when false the check is informational, not a gate. */
    baselineOk: boolean;
    exitCode: number | null;
    timedOut: boolean;
    outputTail: string;
    /** Failing case names from the whole run. */
    failedCases?: string[];
    /** Failing cases BEFORE the edit (the baseline run), and the debugger brief built from them. */
    baselineFailedCases?: string[];
    baselineBrief?: string;
    durationMs: number;
  };
  /** undo_file: whether the previous version was restored to disk. */
  restored?: boolean;
  /** undo_file: history entries left after this pop (0 = drained). */
  remainingDepth?: number;
  /** file_history: newest-first versions (null = file did not exist before that apply). */
  fileHistory?: Array<string | null>;
  astRewritesCount?: number;
  markdown?: string;
  content?: string;
  error?: string;
  tasksPlan?: TaskItem[];
  /** The plan's assumptions and what the workspace said about each (also written to hypotheses.md). */
  hypotheses?: Array<{ id: string; claim: string; probe: string; status: 'open' | 'confirmed' | 'refuted'; evidence?: string }>;
  hypothesesFile?: string;
  /** Set when the gate (enforce) found a refuted assumption and the model supplied one corrected goal that the run then used. */
  replannedGoal?: string;
  tasksFile?: string;
  isPaused?: boolean;
  modelUsed?: string;
  usedFallbackModel?: boolean;
  wiringFiles?: string[];
  wiringContext?: string[];
}

export function formatCodingAgentsMarkdown(result: CodingAgentsResult): string {
  if (result.error) {
    return `### 🤖 Coding Agent Error\n\n**Error:** ${result.error}\n\n${result.pipelineStage ? `_Pipeline Stage: \`${result.pipelineStage}\`_` : ''}`;
  }

  const lines: string[] = [];
  const statusLabel = result.status === 'running'
    ? '⏳ Running in Background'
    : result.status === 'paused'
    ? '⏸️ Workflow Paused (tasks.md)'
    : (result.applied ? '✅ Changes Applied to Disk' : (result.patchPlan?.length ? '🔍 Proposed Plan (Dry Run)' : '⚡ Execution Completed'));
  lines.push(`### 🤖 Coding Agent: ${statusLabel}\n`);
  lines.push(`- **Goal:** ${result.goal}`);
  lines.push(`- **Pipeline Stage:** \`${result.pipelineStage || 'completed'}\``);
  if (result.checkpointId) {
    lines.push(`- **CAS Checkpoint:** \`${result.checkpointId}\``);
  }
  if (result.modelUsed) {
    lines.push(`- **Model Used:** \`${result.modelUsed}\`${result.usedFallbackModel ? ' _(cloud fallback)_' : ''}`);
  }
  if (result.relevantFiles?.length) {
    lines.push(`- **Target Files:** ${result.relevantFiles.map(f => `\`${f}\``).join(', ')}`);
  }
  if (result.wiringFiles?.length) {
    lines.push(`- **Discovered Wiring Targets:** ${result.wiringFiles.map(f => `\`${f}\``).join(', ')}`);
  }
  if (result.anchors?.length) {
    lines.push(`- **Anchors:** ${result.anchors.map(a => `\`${a.hashTag}\``).join(', ')}`);
  }
  if (result.astRewritesCount) {
    lines.push(`- **AST Structural Rewrites:** ${result.astRewritesCount}`);
  }
  if (result.tasksPlan?.length) {
    const doneCount = result.tasksPlan.filter(t => t.status === 'completed').length;
    lines.push(`\n#### 📋 Tasks DAG (${doneCount}/${result.tasksPlan.length} completed)`);
    for (const t of result.tasksPlan) {
      const check = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[~]' : '[ ]');
      lines.push(`- ${check} \`${t.id}\`: ${t.task}`);
    }
  }
  if (result.isPaused) {
    lines.push(`\n> ⏸️ **Workflow Paused**: \`${result.tasksFile || 'tasks.md'}\` created. Pass \`action: "resume"\` to execute next pending task.`);
  }

  const actionableDiagnostics = (result.diagnostics || []).filter(
    d => d.severity !== 'info' || !d.message.toLowerCase().includes('skipped')
  );
  if (actionableDiagnostics.length) {
    lines.push(`\n#### 🩺 Diagnostics (${actionableDiagnostics.length})`);
    for (const d of actionableDiagnostics) {
      const icon = d.severity === 'error' ? '❌' : (d.severity === 'warning' ? '⚠️' : 'ℹ️');
      const loc = d.filePath ? `\`${d.filePath}${d.line ? `:${d.line}` : ''}\`` : '';
      lines.push(`- ${icon} **${d.severity.toUpperCase()}** ${loc}: ${d.message}`);
    }
  }

  if (result.patchPlan?.length) {
    lines.push(`\n#### 📝 Patches (${result.patchPlan.length} file${result.patchPlan.length > 1 ? 's' : ''})`);
    for (const p of result.patchPlan) {
      lines.push(`\n##### \`${p.filePath}\` (${p.anchorTag || 'diff'})`);
      const diffContent = p.unifiedDiff || (p.replacementSnippet ? `@@ -${p.startLine} +${p.startLine} @@\n${p.replacementSnippet}` : '');
      if (diffContent) {
        lines.push('```diff');
        lines.push(diffContent.trim());
        lines.push('```');
      }
    }
  } else if (result.patchSummary) {
    lines.push('\n#### 📝 Patch Summary');
    lines.push('```diff');
    lines.push(result.patchSummary.trim());
    lines.push('```');
  }

  return lines.join('\n');
}
