/**
 * Pure matcher: which registry tools does a prompt refer to? No I/O.
 *
 * Match kinds, strongest first:
 *   exact  – the tool's name appears as a word (or hyphen/space-joined words: "hexstrike ai")
 *   alias  – the registered GitHub repo name appears (phishkit-triage ← "phish-triage")
 *   fuzzy  – one/two typos away, on names of length ≥ 5 only (so `ffuf`/`nmap` never fuzz into each other)
 *
 * Only exact/alias matches may be treated as "the tool". Fuzzy matches are suggestions that
 * the caller must put to the user.
 */

export type MatchKind = 'exact' | 'alias' | 'fuzzy';
export interface ToolMatch { name: string; kind: MatchKind; matched: string }

export interface RegistryEntryLike { url: string }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function tokenize(prompt: string): string[] {
  return prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** All 1–3 word joins of consecutive tokens, so "hexstrike ai" can equal "hexstrike-ai". */
function ngrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    let acc = '';
    for (let n = 0; n < 3 && i + n < tokens.length; n++) { acc += tokens[i + n]; out.add(acc); }
  }
  return out;
}

export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const repoNameOf = (url: string) => /github\.com\/[^/\s]+\/([^/\s#?]+)/i.exec(url)?.[1]?.replace(/\.git$/i, '');

/**
 * Names shorter than 4 normalized chars are too collision-prone to match inside prose
 * (they only match when the whole prompt is that word).
 */
export function matchTools(prompt: string, registry: Record<string, RegistryEntryLike>): ToolMatch[] {
  const tokens = tokenize(prompt);
  if (!tokens.length) return [];
  const grams = ngrams(tokens);
  const found = new Map<string, ToolMatch>();
  const keep = (m: ToolMatch) => {
    const prev = found.get(m.name);
    const rank = { exact: 0, alias: 1, fuzzy: 2 };
    if (!prev || rank[m.kind] < rank[prev.kind]) found.set(m.name, m);
  };

  for (const [name, entry] of Object.entries(registry)) {
    const n = norm(name);
    if (!n) continue;
    const shortOk = n.length >= 4 || tokens.length === 1;
    if (shortOk && grams.has(n)) { keep({ name, kind: 'exact', matched: name }); continue; }
    const repo = repoNameOf(entry.url);
    const r = repo ? norm(repo) : '';
    if (r && r !== n && r.length >= 4 && grams.has(r)) { keep({ name, kind: 'alias', matched: repo! }); continue; }
    if (n.length >= 5) {
      const maxD = n.length >= 8 ? 2 : 1;
      for (const g of grams) {
        if (g.length >= 5 && editDistance(g, n, maxD) <= maxD) { keep({ name, kind: 'fuzzy', matched: g }); break; }
      }
    }
  }
  const order = { exact: 0, alias: 1, fuzzy: 2 };
  return [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** The confident picks (exact/alias) vs. the ones that need a human to confirm. */
export function splitMatches(ms: ToolMatch[]): { confident: ToolMatch[]; suggestions: ToolMatch[] } {
  return { confident: ms.filter(m => m.kind !== 'fuzzy'), suggestions: ms.filter(m => m.kind === 'fuzzy') };
}

export type Intent = 'overview' | 'dependencies' | 'skills' | 'tools' | 'usage' | 'install';
export type SourceName = 'github' | 'apt' | 'docker';

const INTENT_PATTERNS: [Intent, RegExp][] = [
  ['dependencies', /\b(depend(?:s|encies|ency)?|librar(?:y|ies)|packages?|requirements?|imports?)\b/i],
  ['skills', /\bskills?\b/i],
  ['tools', /\b(mcp|tools?\s+(?:it\s+)?(?:has|offers|provides|exposes)|what tools|capabilit)/i],
  ['install', /\b(install|apt\b|apt-get|docker pull|pull)\b/i],
  ['usage', /\b(usage|use it|how (?:do|to)|example|run|command|flags?|options?)\b/i],
];

export function detectIntent(prompt: string): Intent {
  for (const [intent, re] of INTENT_PATTERNS) if (re.test(prompt)) return intent;
  return 'overview';
}

export function detectSource(prompt: string): SourceName | undefined {
  if (/\b(docker\s?hub|docker|container|image)\b/i.test(prompt)) return 'docker';
  if (/\b(apt|apt-get|debian|ubuntu|kali|dpkg)\b/i.test(prompt)) return 'apt';
  if (/\b(github|repo(?:sitory)?|source code|git)\b/i.test(prompt)) return 'github';
  return undefined;
}
