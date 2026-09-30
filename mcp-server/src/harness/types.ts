// Shared types for the background agent harness. See docs/plans/2026-09-29-agent-harness.md.

export interface AllowRule {
  tool: string;
  actions?: string[];
  constraints?: Record<string, unknown>;
}

export interface RoleDeclaration {
  triggers?: string[];
  requiresApproval?: boolean;
  tools: AllowRule[];
}

export interface HarnessDeclaration {
  harness: {
    name: string;
    schemaVersion: number;
    primaryLane: string;
    budget: {
      maxTokens: number;
      maxToolCalls: number;
      maxWallMinutes: number;
      supervisorShareMax: number;
    };
    /**
     * Absolute path prefixes a run may touch. Unset/empty = unrestricted
     * (matches coding_agents' current behavior — assertSafe there guards
     * traversal WITHIN a workspaceRoot but never validates workspaceRoot
     * itself against an allowlist). Declaring this list is how a harness
     * deployment gets scoped to specific project directories instead of
     * accepting any absolute path a caller supplies.
     */
    allowedWorkspaceRoots?: string[];
    approval: {
      timeoutMinutes: number;
      standingRules: AllowRule[];
    };
  };
  roles: Record<string, RoleDeclaration>;
  writes: AllowRule[];
  contentDepth: { order: string[]; default: string };
  handoff: { schemaVersion: number; lowConfidenceThreshold: number; maxDepth: number };
  /** P4e trial-and-error bounds (docs/plans/2026-09-29-harness-p4-subagents-brain.md, D5). Both optional — absent means the pre-P4e default (2 attempts, deterministic heuristic strategy selection). */
  limits?: { maxAttemptsPerStep?: number };
  reasoning?: { strategy?: 'heuristic' | 'quantum' };
}

export type PolicyDecision =
  | { kind: 'allow'; rule: AllowRule }
  | { kind: 'needs_approval'; reason: string }
  | { kind: 'deny'; reason: string };

export interface ApprovalRequest {
  id: string;
  runId: string;
  callId: string;
  role: string;
  tool: string;
  action?: string;
  args: unknown;
  argsHash: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
}

export interface TraceEvent {
  runId: string;
  seq: number;
  ts: number;
  role: string;
  type:
    | 'run_start'
    | 'plan'
    | 'tool_call'
    | 'tool_result'
    | 'policy_decision'
    | 'approval_requested'
    | 'approval_decided'
    | 'budget'
    | 'handoff'
    | 'error'
    | 'run_end'
    | 'trace_truncated'
    | 'monitor_attached'
    | 'monitor_progress'
    | 'monitor_done';
  data: unknown;
  tokens?: { input: number; output: number; reservedRemaining: number };
}

export interface HarnessRun {
  runId: string;
  harness: string;             // decl.harness.name — human-readable display name
  declarationName: string;     // the loadHarnessDeclaration() name (e.g. 'research-analysis') — needed to reload the same declaration on resume
  goal: string;
  workspaceRoot?: string;
  status: 'running' | 'paused_approval' | 'paused_budget' | 'monitoring' | 'complete' | 'failed' | 'aborted';
  budget: { maxTokens: number; used: number; reserved: number; toolCalls: number; perRole?: Record<string, number> };
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * P5 — set while `status === 'monitoring'`: a step attached to a detached
   * process (gatedDetach) instead of completing synchronously. The step
   * engine can't build that step's handoff yet (no content exists until the
   * process finishes), so the WHOLE run pauses here — a first-class state
   * distinct from paused_approval/paused_budget, not a repurposing of
   * either. resumeHarness checks MonitorRegistry for this monitorId: still
   * running -> no-op (poll again later); done -> its result becomes this
   * step's content and the step loop continues from stepIndex+1; the
   * registry losing the entry (e.g. a server restart) or the process itself
   * failing both end the run 'failed', never left silently 'monitoring'
   * forever.
   */
  pendingMonitor?: { monitorId: string; stepIndex: number; role: string };
}
