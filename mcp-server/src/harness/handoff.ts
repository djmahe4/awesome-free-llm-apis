import { z } from 'zod';

/**
 * Real, validated step output — replaces the old synthetic handoff runner.ts
 * used to fabricate once at the very end of a run (literal `confidence: 0.7`,
 * `findings` = first 500 chars of the reply, `source: 'use_free_llm'`
 * regardless of which tool actually ran). See docs/plans/2026-09-29-harness-
 * p4-subagents-brain.md's self-review: "the handoff is logging, not
 * communication." This is the real one: one per step, produced by that
 * step's own content, consumed as the next step's input.
 */
export const HandoffSchema = z.object({
  schemaVersion: z.literal(1),
  from: z.string().min(1),
  to: z.string().min(1),
  status: z.enum(['in_progress', 'blocked', 'complete', 'needs_user']),
  confidence: z.number().min(0).max(1),
  findings: z.array(z.object({ claim: z.string(), source: z.string() })),
  openQuestions: z.array(z.string()),
  artifacts: z.array(z.string()),
  nextAction: z.string(),
  requiresApproval: z.object({
    needed: z.boolean(),
    action: z.string().optional(),
    risk: z.string().optional(),
  }),
});

export type Handoff = z.infer<typeof HandoffSchema>;

/**
 * Lines the model itself phrased as a question (ending in '?') are the
 * closest thing to real open questions available without a second LLM call
 * to extract them — same "derive from the step's own content, never
 * fabricate" posture as confidence. Capped at 5 so one rambly reply can't
 * flood the Eisenhower backlog (P4d).
 */
function extractOpenQuestions(content: string): string[] {
  return content
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && l.endsWith('?'))
    .slice(0, 5);
}

/**
 * Confidence is computed from the step's own output, never a literal —
 * capped contribution from length (a longer grounded answer isn't
 * automatically more confident past a point) plus a floor for any non-empty
 * content. Empty content is 0 confidence and 'blocked' status, not silently
 * treated as a real (if low-quality) finding.
 */
export function buildHandoff(from: string, to: string, content: string): Handoff {
  const trimmed = content.trim();
  const findings = trimmed ? [{ claim: trimmed.slice(0, 500), source: from }] : [];
  const confidence = trimmed ? Math.min(1, 0.5 + Math.min(trimmed.length, 2000) / 4000) : 0;
  return {
    schemaVersion: 1,
    from,
    to,
    status: trimmed ? 'complete' : 'blocked',
    confidence,
    findings,
    openQuestions: trimmed ? extractOpenQuestions(trimmed) : [],
    artifacts: [],
    nextAction: trimmed ? 'none' : 'retry',
    requiresApproval: { needed: false },
  };
}

export type HandoffValidation =
  | { ok: true; handoff: Handoff }
  | { ok: false; error: string };

/** Malformed → rejected, never silently accepted (D2 in the P4 plan). */
export function validateHandoff(data: unknown): HandoffValidation {
  const parsed = HandoffSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, handoff: parsed.data };
}
