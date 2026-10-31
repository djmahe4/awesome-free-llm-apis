import fs from 'node:fs/promises';
import path from 'node:path';
import { parseHypothesesMarkdown, serializeHypothesisRow, validateHypotheses, parseProbe, type Hypothesis } from '../tools/coding-agents/hypotheses.js';

/**
 * Wiki pages can carry a claims table (the same rows as hypotheses.md) naming what the page says about the code and
 * a probe that checks it. Writing a page re-runs the probes against the workspace, so a page whose claims are no
 * longer true stops gaining confidence and cannot turn into an ADR, whoever wrote it or edited it by hand.
 *
 * WIKI_CLAIM_VERIFICATION: off | warn (default: pages are tagged, confidence and ADRs are unchanged) | enforce.
 */

export type ClaimMode = 'off' | 'warn' | 'enforce';
export type PageVerdict = 'verified' | 'unverified' | 'no-claims';

export const UNVERIFIED_TAG = 'unverified';
/** Without a confirmed claim a page cannot climb past this (the ADR threshold is 0.85). */
export const UNCHECKED_CONFIDENCE_CAP = 0.7;

export function claimMode(): ClaimMode {
  const v = process.env.WIKI_CLAIM_VERIFICATION;
  return v === 'off' || v === 'warn' || v === 'enforce' ? v : 'warn';
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|c|cc|cpp|h|hpp|swift)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.free-llm-mcp', '.next', 'coverage', '__pycache__', 'target']);
const MAX_FILES = 2000;

async function codeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); }
      else if (CODE_EXT.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  await walk(root, '');
  return out;
}

export interface PageCheck {
  verdict: PageVerdict;
  claims: Hypothesis[];
  /** The page text with each claim row rewritten to the status the probe gave (a hand-typed status is not kept). */
  content: string;
}

/** Re-runs every claim on the page. The status written on the page is ignored; the probe decides. */
export async function checkPageClaims(content: string, workspaceRoot: string): Promise<PageCheck> {
  const written = parseHypothesesMarkdown(content);
  if (written.length === 0) return { verdict: 'no-claims', claims: [], content };
  const checked = await validateHypotheses(written, workspaceRoot, { files: await codeFiles(workspaceRoot) });
  // a claim whose probe cannot be run proves nothing: it is neither a pass nor a failure
  const claims = checked.map(h => (parseProbe(h.probe) ? h : { ...h, status: 'open' as const, evidence: 'probe not recognised, so nothing was checked' }));
  const byId = new Map(claims.map(h => [h.id, h]));
  const rewritten = content.split(/\r?\n/).map(line => {
    if (!line.startsWith('|')) return line;
    const first = line.split('|')[1]?.trim();
    const h = first ? byId.get(first) : undefined;
    return h ? serializeHypothesisRow(h) : line;
  }).join('\n');
  const refuted = claims.some(h => h.status === 'refuted');
  const confirmed = claims.some(h => h.status === 'confirmed');
  return { verdict: refuted ? 'unverified' : confirmed ? 'verified' : 'no-claims', claims, content: rewritten };
}
