import crypto from 'node:crypto';
import path from 'node:path';
import type { AllowRule, HarnessDeclaration, PolicyDecision } from './types.js';

/**
 * Recursively sorts object keys at EVERY depth and walks arrays positionally,
 * so structurally-different values never produce the same string. This
 * replaces a real bug: `JSON.stringify(args, Object.keys(args).sort())`
 * treats its 2nd argument as a property allowlist, not a key sorter — it's
 * applied recursively, so only TOP-LEVEL key names survive at any depth.
 * {cmd:{run:"ls"}} and {cmd:{run:"rm -rf /"}} both serialized to {"cmd":{}},
 * meaning an approval granted for one nested payload silently authorized
 * any other payload sharing the same top-level key names.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify(undefined) is the literal `undefined` (not valid JSON) —
    // normalize so hashArgs never hands crypto a non-string.
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** Canonical, deterministic hash of a call's arguments — used to bind an approval to the exact call it was granted for. */
export function hashArgs(args: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(args ?? null)).digest('hex').slice(0, 24);
}

/**
 * Array-valued constraint = membership, not equality. `{skillTags:['cyber']}`
 * means "args.skillTags (or args.skillTag) must contain/equal one of these",
 * not "must strictly equal the array" — lets a rule express an allowlist set
 * (e.g. skill-tag gating) instead of pinning one exact value.
 */
function constraintsMatch(constraints: Record<string, unknown> | undefined, args: any): boolean {
  if (!constraints) return true;
  for (const [key, expected] of Object.entries(constraints)) {
    const actual = args?.[key];
    if (Array.isArray(expected)) {
      if (Array.isArray(actual)) {
        if (!actual.some(v => expected.includes(v))) return false;
      } else if (!expected.includes(actual)) {
        return false;
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function ruleMatches(rule: AllowRule, tool: string, action: string | undefined, args: any): boolean {
  if (rule.tool !== tool) return false;
  if (rule.actions && (!action || !rule.actions.includes(action))) return false;
  return constraintsMatch(rule.constraints, args);
}

/**
 * T5 — strips a lane cycle suffix: `fixer#c2` → `fixer`. The plan array
 * (tasks.md cursor) keeps the full id so each cycle is its own task, but
 * everything keyed by role name — policy lookup, handoff from/to, trace
 * role, budget.perRole, lessons — must resolve to the BASE role so cycle 2
 * of a phase runs under the same declaration entry (and the same allowlist)
 * as cycle 1. Ids without a suffix pass through unchanged, so legacy
 * declarations are unaffected.
 */
export function stripCycleSuffix(id: string): string {
  return id.replace(/#c\d+$/, '');
}

/**
 * Default-deny policy evaluation. A call is allowed only if:
 *   - the role is not `requiresApproval` (coder is, always), AND
 *   - some rule for that role (or the shared `writes` list) matches tool+action+constraints.
 * Everything else needs an explicit approval — this function never grants one itself,
 * it only decides whether a call may proceed WITHOUT one.
 */
export function evaluate(
  decl: HarnessDeclaration,
  role: string,
  tool: string,
  action: string | undefined,
  args: any
): PolicyDecision {
  // T5 defense-in-depth: a suffixed lane id (`scanner#c2`) is evaluated as
  // its base role — runSteps already strips, but any future caller passing
  // a raw plan id must still hit the right rules instead of 'Unknown role'.
  const baseRole = stripCycleSuffix(role);
  const roleDef = decl.roles[baseRole];
  if (!roleDef) return { kind: 'deny', reason: `Unknown role '${baseRole}' in harness '${decl.harness.name}'` };

  if (roleDef.requiresApproval) {
    return { kind: 'needs_approval', reason: `Role '${baseRole}' requires approval for every call (gated lane)` };
  }

  for (const rule of roleDef.tools ?? []) {
    if (ruleMatches(rule, tool, action, args)) return { kind: 'allow', rule };
  }
  for (const rule of decl.writes ?? []) {
    if (ruleMatches(rule, tool, action, args)) return { kind: 'allow', rule };
  }

  return { kind: 'needs_approval', reason: `No allowlist rule for tool='${tool}' action='${action ?? ''}' under role '${baseRole}'` };
}

/**
 * T4 — cycle budget for a declaration's lane.
 *
 *   lane + maxCycles: N   — runner may walk the phase list N times
 *   lane only:             1 — single pass (explicit lane, implicit cap)
 *   no lane:               null — legacy linear lane, no cycle semantics
 */
export function laneCycleMax(decl: HarnessDeclaration): number | null {
  const lane = decl.harness.lane;
  if (!lane || lane.length === 0) return null;
  return decl.harness.maxCycles ?? 1;
}

/**
 * T4 — 1-based gate for starting cycle `cycle` of a cyclic lane. Returns
 * false (never throws) for legacy declarations without a lane, so a caller
 * that forgot to check `laneCycleMax` first fails closed instead of running
 * an unbounded loop.
 */
export function canStartLaneCycle(decl: HarnessDeclaration, cycle: number): boolean {
  const max = laneCycleMax(decl);
  return max !== null && Number.isInteger(cycle) && cycle >= 1 && cycle <= max;
}

/**
 * Validates a workspace_root against the declaration's `allowedWorkspaceRoots`
 * — a boundary check, not an allowlist rule, so it's a hard throw (like
 * coding-agents.ts's assertSafe for path traversal WITHIN a workspace root)
 * rather than a `needs_approval` a human could rubber-stamp around. Unset/
 * empty list means the declaration hasn't opted into this restriction —
 * unrestricted, matching today's default posture, not fail-closed.
 */
export function assertWorkspaceRootAllowed(decl: HarnessDeclaration, workspaceRoot: string | undefined): void {
  const allowed = decl.harness.allowedWorkspaceRoots;
  if (!allowed || allowed.length === 0) return;
  if (!workspaceRoot) {
    throw new Error(`Harness '${decl.harness.name}' requires workspace_root to be one of: ${allowed.join(', ')}`);
  }
  const resolved = path.resolve(workspaceRoot);
  const ok = allowed.some(root => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
  if (!ok) {
    throw new Error(`workspace_root '${workspaceRoot}' is not permitted by harness '${decl.harness.name}' (allowed: ${allowed.join(', ')})`);
  }
}
