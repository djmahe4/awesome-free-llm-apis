/**
 * Pure matcher: which registry tools does a prompt refer to? No I/O.
 *
 * Match kinds, strongest first:
 *   exact  – the tool's name appears as a word (or hyphen/space-joined words: "hexstrike ai")
 *   alias  – the registered GitHub repo name appears (phishkit-triage ← "phish-triage")
 *   desc   – a distinctive prompt token/phrase appears as a whole word in the tool's registry description
 *   fuzzy  – one/two typos away, on names of length ≥ 5 only (so `ffuf`/`nmap` never fuzz into each other)
 *
 * Only exact/alias/desc matches may be treated as "the tool". Fuzzy matches are suggestions that
 * the caller must put to the user.
 */

export type MatchKind = 'exact' | 'alias' | 'desc' | 'fuzzy';
export interface ToolMatch { name: string; kind: MatchKind; matched: string }

export interface RegistryEntryLike { url: string }

const DESC_MIN_TOKEN = 5;
const DESC_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'before', 'being', 'between',
  'could', 'doing', 'during', 'every', 'from', 'have', 'into', 'itself', 'more',
  'most', 'only', 'other', 'over', 'same', 'should', 'some', 'such', 'than',
  'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'under', 'until', 'very', 'were', 'what', 'when', 'where', 'which',
  'while', 'with', 'would', 'your', 'tool', 'tools', 'using', 'used', 'use',
  'open', 'source', 'free', 'network', 'security', 'scan', 'scans', 'scanner',
  'utilities', 'utility', 'program', 'package', 'project', 'github',
]);

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

function descMatch(name: string, description: string | undefined, tokens: string[]): ToolMatch | null {
  if (!description) return null;
  const desc = description.toLowerCase();
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 3; n >= 1; n--) {
      if (i + n > tokens.length) continue;
      const phrase = tokens.slice(i, i + n);
      if (phrase.some(t => t.length < DESC_MIN_TOKEN || DESC_STOPWORDS.has(t))) continue;
      const joined = phrase.join(' ');
      if (phrase.length > 1) {
        const re = new RegExp(`(?:^|[^a-z0-9])${phrase.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+')}(?:[^a-z0-9]|$)`);
        if (re.test(desc)) return { name, kind: 'desc', matched: joined };
      } else if (new RegExp(`(?:^|[^a-z0-9])${phrase[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`).test(desc)) {
        return { name, kind: 'desc', matched: phrase[0] };
      }
    }
  }
  return null;
}

/**
 * Names shorter than 4 normalized chars are too collision-prone to match inside prose
 * (they only match when the whole prompt is that word).
 */
export function matchTools(
  prompt: string,
  registry: Record<string, RegistryEntryLike>,
  descriptions?: Record<string, string>,
): ToolMatch[] {
  const tokens = tokenize(prompt);
  if (!tokens.length) return [];
  const grams = ngrams(tokens);
  const found = new Map<string, ToolMatch>();
  const keep = (m: ToolMatch) => {
    const prev = found.get(m.name);
    const rank = { exact: 0, alias: 1, desc: 2, fuzzy: 3 };
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
    if (descriptions) {
      const dm = descMatch(name, descriptions[name] ?? descriptions[name.toLowerCase()], tokens);
      if (dm) { keep(dm); continue; }
    }
    if (n.length >= 5) {
      const maxD = n.length >= 8 ? 2 : 1;
      for (const g of grams) {
        if (g.length >= 5 && editDistance(g, n, maxD) <= maxD) { keep({ name, kind: 'fuzzy', matched: g }); break; }
      }
    }
  }
  const order = { exact: 0, alias: 1, desc: 2, fuzzy: 3 };
  return [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** The confident picks (exact/alias/desc) vs. the ones that need a human to confirm. */
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
