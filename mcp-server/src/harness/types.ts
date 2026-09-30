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
    | 'trace_truncated';
  data: unknown;
  tokens?: { input: number; output: number; reservedRemaining: number };
}

export interface HarnessRun {
  runId: string;
  harness: string;             // decl.harness.name — human-readable display name
  declarationName: string;     // the loadHarnessDeclaration() name (e.g. 'research-analysis') — needed to reload the same declaration on resume
  goal: string;
  workspaceRoot?: string;
  status: 'running' | 'paused_approval' | 'paused_budget' | 'complete' | 'failed' | 'aborted';
  budget: { maxTokens: number; used: number; reserved: number; toolCalls: number };
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
