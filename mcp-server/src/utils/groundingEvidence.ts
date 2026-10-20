/**
 * Identity evidence: decides whether a Docker image / Debian package / etc. is really
 * the SAME project as a registry tool, or merely shares its name.
 *
 * Why this exists (found live, not hypothetical): the registry's `hydra` is THC-Hydra,
 * the password cracker. Docker Hub's top image literally named `hydra` is `oryd/hydra`
 * (431M pulls) — an OAuth2 server. Name equality alone would have answered a security
 * question with a confident, wrong, grounded-looking citation.
 *
 * Levels (strongest first):
 *   strong    — the candidate itself points at the registered GitHub repo (homepage / README
 *               link), is published by the same GitHub owner, or is named after the repo
 *               (`thc-hydra`). Safe to present as THE answer.
 *   domain    — name matches AND its own text uses specific security-tool vocabulary
 *               ("network mapper", "SQL injection", "password cracker"...). Safe to present.
 *   name-only — only the name matches. Never presented as the answer: surfaced as an
 *               "is this what you meant?" follow-up with its own description attached.
 * `null` means no tie at all.
 */

export interface ToolProfile {
  /** Registry name, lowercase. */
  name: string;
  /** Distinct lowercase names worth searching under: the registry name plus the GitHub repo name (hydra -> thc-hydra). */
  aliases: string[];
  github?: { owner: string; repo: string; url: string };
}

export type EvidenceLevel = 'strong' | 'domain' | 'name-only';
export interface Evidence { level: EvidenceLevel; reasons: string[] }

export interface CandidateFacts {
  /** The candidate's own name: docker repo, debian source/binary package, kali project. */
  name: string;
  /** Publisher: docker namespace, github owner. */
  owner?: string;
  /** Upstream homepage when the source states one (debian/control `Homepage:`). */
  homepage?: string;
  /** Descriptions / README excerpt, concatenated. */
  text?: string;
}

/**
 * Specific security-tool vocabulary. Deliberately excludes bare "security", "network",
 * "password", "auth", "server": ORY Hydra's own description is "Scalable, security first
 * OAuth 2.0 and OpenID Connect server" and must NOT pass as a security tool.
 */
export const CYBER_DOMAIN_RE = new RegExp(
  '\\b(' + [
    'scan(?:ner|ners|ning)?', 'network mapper', 'pentest(?:ing|er)?', 'penetration[- ]test(?:ing|er)?',
    'exploit(?:s|ation)?', 'vulnerabilit(?:y|ies)', 'vuln', 'brute[- ]?forc(?:e|er|ing)', 'crack(?:er|ing)',
    'fuzz(?:er|ers|ing)?', 'enumerat(?:e|ion|or)', 'reconnaissance', 'recon', 'osint', 'subdomains?',
    'sql ?injection', 'sqli', 'payloads?', 'reverse shell', 'packet (?:sniff|captur)\\w*', 'forensics?',
    'malware', 'red[- ]team(?:ing)?', 'command and control', 'c2', 'ctf', 'bug bount(?:y|ies)',
  ].join('|') + ')\\b',
  'i'
);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildToolProfile(name: string, registryUrl?: string): ToolProfile {
  const lower = name.trim().toLowerCase();
  const m = registryUrl?.match(/github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i);
  const github = m ? { owner: m[1], repo: m[2].replace(/\.git$/i, ''), url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}` } : undefined;
  const aliases = [...new Set([lower, ...(github ? [github.repo.toLowerCase()] : [])])];
  return { name: lower, aliases, github };
}

export function assessEvidence(profile: ToolProfile, c: CandidateFacts): Evidence | null {
  const name = c.name.toLowerCase();
  const nameMatch = profile.aliases.includes(name);
  const gh = profile.github;
  const reasons: string[] = [];

  if (gh) {
    // (?![\w-]) so github.com/nmap/nmap does not match github.com/nmap/nmap-docs.
    const ghRe = new RegExp(`github\\.com/${escapeRe(gh.owner)}/${escapeRe(gh.repo)}(?![\\w-])`, 'i');
    if (c.homepage && ghRe.test(c.homepage)) reasons.push('its homepage is the registered GitHub repo');
    if (c.text && ghRe.test(c.text)) reasons.push('its description links the registered GitHub repo');
    if (nameMatch && c.owner && c.owner.toLowerCase() === gh.owner.toLowerCase()) reasons.push(`published by the same GitHub owner (${gh.owner})`);
    if (name === gh.repo.toLowerCase() && gh.repo.toLowerCase() !== profile.name) reasons.push(`named after the registered GitHub repo (${gh.repo})`);
    if (reasons.length > 0) return { level: 'strong', reasons };
  }

  if (!nameMatch) return null;

  const hit = c.text ? CYBER_DOMAIN_RE.exec(c.text) : null;
  if (hit) return { level: 'domain', reasons: [`name match plus security-tool wording ("${hit[0]}")`] };
  return { level: 'name-only', reasons: ['only the name matches — nothing ties it to the registered tool'] };
}

/** Whether this evidence is enough to present the candidate as the answer rather than ask about it. */
export const isGrounded = (e: Evidence | null): e is Evidence => !!e && (e.level === 'strong' || e.level === 'domain');
