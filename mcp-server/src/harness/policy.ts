import crypto from 'node:crypto';
import type { AllowRule, HarnessDeclaration, PolicyDecision } from './types.js';

/** Canonical, deterministic hash of a call's arguments — used to bind an approval to the exact call it was granted for. */
export function hashArgs(args: unknown): string {
  const canonical = JSON.stringify(args, Object.keys(args as object ?? {}).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

function constraintsMatch(constraints: Record<string, unknown> | undefined, args: any): boolean {
  if (!constraints) return true;
  for (const [key, expected] of Object.entries(constraints)) {
    if (args?.[key] !== expected) return false;
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
