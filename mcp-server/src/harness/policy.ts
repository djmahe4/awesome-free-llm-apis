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
  const roleDef = decl.roles[role];
  if (!roleDef) return { kind: 'deny', reason: `Unknown role '${role}' in harness '${decl.harness.name}'` };

  if (roleDef.requiresApproval) {
    return { kind: 'needs_approval', reason: `Role '${role}' requires approval for every call (gated lane)` };
  }

  for (const rule of roleDef.tools ?? []) {
    if (ruleMatches(rule, tool, action, args)) return { kind: 'allow', rule };
  }
  for (const rule of decl.writes ?? []) {
    if (ruleMatches(rule, tool, action, args)) return { kind: 'allow', rule };
  }

  return { kind: 'needs_approval', reason: `No allowlist rule for tool='${tool}' action='${action ?? ''}' under role '${role}'` };
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
