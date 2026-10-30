/**
 * Parameter-gap ratchet: inputs the MCP schema accepts but the playground or Quickstart does not show used to
 * be a printed notice nobody acted on. The existing gaps are recorded in a baseline file; a NEW gap (a field
 * added to a schema without adding it to the frontend) fails the pre-commit check, and the baseline can only shrink.
 */

export type Gaps = Record<string, { playground: string[]; quickstart: string[] }>;

export function computeGaps(
  schema: Record<string, string[]>,
  playground: Record<string, string[]>,
  quickstart: Record<string, string[]>,
  tools: Iterable<string>,
): Gaps {
  const out: Gaps = {};
  for (const tool of tools) {
    const props = schema[tool] ?? [];
    const pg = props.filter(p => !(playground[tool] ?? []).includes(p)).sort();
    const qs = props.filter(p => !(quickstart[tool] ?? []).includes(p)).sort();
    if (pg.length || qs.length) out[tool] = { playground: pg, quickstart: qs };
  }
  return out;
}

export function findNewGaps(current: Gaps, baseline: Gaps): string[] {
  const problems: string[] = [];
  for (const [tool, gaps] of Object.entries(current)) {
    for (const where of ['playground', 'quickstart'] as const) {
      const known = new Set(baseline[tool]?.[where] ?? []);
      const added = gaps[where].filter(p => !known.has(p));
      if (added.length) problems.push(`[${tool}] ${where} does not show: ${added.join(', ')}`);
    }
  }
  return problems;
}

/** Baseline entries that are no longer gaps: the baseline should be regenerated so it only shrinks. */
export function findClosedGaps(current: Gaps, baseline: Gaps): string[] {
  const closed: string[] = [];
  for (const [tool, gaps] of Object.entries(baseline)) {
    for (const where of ['playground', 'quickstart'] as const) {
      const now = new Set(current[tool]?.[where] ?? []);
      const gone = gaps[where].filter(p => !now.has(p));
      if (gone.length) closed.push(`[${tool}] ${where}: ${gone.join(', ')}`);
    }
  }
  return closed;
}
