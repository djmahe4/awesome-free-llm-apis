import { httpGetJson, httpGetText, type HttpOptions } from './http.js';
import { failFromHttp, notFound, SAFE_NAME_RE, type GroundingHint, type Lookup } from './grounding.js';
import { assessEvidence, isGrounded, type Evidence, type ToolProfile } from './groundingEvidence.js';

/**
 * apt grounding across the three distros a security tool is realistically installed from.
 * Every endpoint below was exercised live before this was written:
 *
 *   debian  GET sources.debian.org/api/src/<source>/            versions[{area,suites,version}]
 *           GET sources.debian.org/data/<area>/<prefix>/<src>/<ver>/debian/control   (text)
 *           -> the real binary package names, a description, and the upstream `Homepage`
 *              (hydra's Homepage is exactly the registry's github.com/vanhauser-thc/thc-hydra).
 *           TRAP: "no such package" is HTTP 200 with body {"error":404}, not a 404 status.
 *   ubuntu  GET api.launchpad.net/devel/ubuntu/+source/<source>   200 / 404 (fast, ~2s).
 *           The getPublishedSources query that returns versions takes ~17s, so it is not used.
 *   kali    GET gitlab.com/api/v4/projects/kalilinux%2Fpackages%2F<source>   200 / 404
 *           description is only "<name> packaging for Kali Linux" — no domain wording.
 *
 * Lookups are by SOURCE package name; a binary-only name (e.g. `ncat`, built from `nmap`)
 * correctly reports not found rather than guessing.
 */

export type AptDistro = 'debian' | 'ubuntu' | 'kali';

export interface AptHit {
  distro: AptDistro;
  sourcePackage: string;
  /** Binary packages built from the source (known for Debian only). */
  binaries: string[];
  /** The package to `apt install` — a real binary name when we know them. */
  installPackage: string;
  installCommand: string;
  version?: string;
  suites?: string[];
  description?: string;
  homepage?: string;
  evidence: Evidence;
  /** Human-facing page for this package. */
  url: string;
  /** API/data URLs actually consulted — provenance. */
  sources: string[];
}

export interface AptResolution {
  best: AptHit;
  /** Every grounded hit (best included), best first. */
  hits: AptHit[];
  /** Same-name packages that could NOT be tied to the tool. */
  unverified: AptHit[];
  checked: string[];
}

export interface ControlInfo {
  homepage?: string;
  binaries: Array<{ package: string; description: string }>;
}

/** Parses the pieces of a debian/control file we use. Continuation lines (leading whitespace) are ignored; only the synopsis line is kept. */
export function parseControl(text: string): ControlInfo {
  const stanzas = text.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const field = (stanza: string, name: string): string | undefined => {
    const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(stanza);
    return m ? m[1].trim() : undefined;
  };
  let homepage: string | undefined;
  const binaries: ControlInfo['binaries'] = [];
  for (const st of stanzas) {
    homepage = homepage ?? field(st, 'Homepage');
    const pkg = field(st, 'Package');
    if (pkg) binaries.push({ package: pkg, description: field(st, 'Description') ?? '' });
  }
  return { homepage, binaries };
}

/** Chooses the binary to install: the one named like the tool, else the first that is not docs/debug/data. */
export function pickInstallPackage(profile: ToolProfile, binaries: string[], fallback: string): string {
  for (const a of profile.aliases) if (binaries.includes(a)) return a;
  const primary = binaries.find(b => !/-(doc|docs|dbg|dev|common|data|examples)$/.test(b));
  return primary ?? binaries[0] ?? fallback;
}

const UBUNTU_TIMEOUT_MS = 4_000;

const debianPrefix = (pkg: string) => (pkg.startsWith('lib') ? pkg.slice(0, 4) : pkg[0]);
// Debian versions may carry an epoch (nikto is `1:2.1.5-3.1`); the colon is valid in the data URL path (verified live).
const SAFE_VERSION_RE = /^[A-Za-z0-9.+~:_-]+$/;

export class AptPackageClient {
  constructor(private readonly http: HttpOptions = {}) {}

  private async debian(profile: ToolProfile, name: string): Promise<Lookup<AptHit>> {
    const srcUrl = `https://sources.debian.org/api/src/${name}/`;
    const res = await httpGetJson<any>(srcUrl, this.http);
    if (!res.ok) return failFromHttp(res, `Debian source package "${name}"`);
    const versions: Array<{ area?: string; suites?: string[]; version?: string }> | undefined = res.json?.versions;
    // Debian reports an unknown package as HTTP 200 + {"error":404}; treat "no versions" as not found.
    if (!Array.isArray(versions) || versions.length === 0) {
      return res.json?.error === 404 || !res.json?.versions
        ? notFound('not_found', `Debian has no source package "${name}"`, srcUrl)
        : notFound('unexpected_response', 'Debian source API: unexpected body', srcUrl);
    }
    const pick = versions.find(v => v.suites?.includes('sid')) ?? versions.find(v => v.suites?.includes('unstable')) ?? versions[0];
    const version = pick.version;
    const area = pick.area ?? 'main';
    const sources = [srcUrl];

    let control: ControlInfo = { binaries: [] };
    if (version && SAFE_VERSION_RE.test(version) && /^[a-z-]+$/.test(area)) {
      const ctlUrl = `https://sources.debian.org/data/${area}/${debianPrefix(name)}/${name}/${version}/debian/control`;
      const ctl = await httpGetText(ctlUrl, { ...this.http, headers: { ...this.http.headers, Accept: 'text/plain, */*' } });
      if (ctl.ok && ctl.text) { control = parseControl(ctl.text); sources.push(ctlUrl); }
    }

    const binaryNames = control.binaries.map(b => b.package);
    const installPackage = pickInstallPackage(profile, binaryNames, name);
    const description = control.binaries.find(b => b.package === installPackage)?.description || control.binaries[0]?.description || undefined;
    const evidence = assessEvidence(profile, { name, homepage: control.homepage, text: `${description ?? ''}\n${control.binaries.map(b => b.description).join('\n')}` });
    if (!evidence) return notFound('not_found', `Debian package "${name}" does not match the tool`, srcUrl);

    return {
      found: true, url: `https://packages.debian.org/sid/${installPackage}`,
      data: {
        distro: 'debian', sourcePackage: name, binaries: binaryNames, installPackage,
        installCommand: `sudo apt install ${installPackage}`,
        version, suites: pick.suites, description, homepage: control.homepage, evidence,
        url: `https://packages.debian.org/sid/${installPackage}`, sources,
      },
    };
  }

  private async ubuntu(profile: ToolProfile, name: string): Promise<Lookup<AptHit>> {
    // Launchpad is slow and only corroborates Debian (Ubuntu syncs from it): short cap, no retries,
    // so it can never hold the whole lookup hostage (it did: 12s on every call before this cap).
    const url = `https://api.launchpad.net/devel/ubuntu/+source/${name}`;
    const res = await httpGetJson<any>(url, { ...this.http, timeoutMs: Math.min(this.http.timeoutMs ?? 15_000, UBUNTU_TIMEOUT_MS), retries: 0 });
    if (!res.ok) return failFromHttp(res, `Ubuntu source package "${name}"`);
    const evidence = assessEvidence(profile, { name, text: '' });
    if (!evidence) return notFound('not_found', `Ubuntu package "${name}" does not match the tool`, url);
    return {
      found: true, url: res.json?.web_link ?? `https://launchpad.net/ubuntu/+source/${name}`,
      data: {
        distro: 'ubuntu', sourcePackage: name, binaries: [], installPackage: name,
        installCommand: `sudo apt install ${name}`, evidence,
        url: res.json?.web_link ?? `https://launchpad.net/ubuntu/+source/${name}`, sources: [url],
      },
    };
  }

  private async kali(profile: ToolProfile, name: string): Promise<Lookup<AptHit>> {
    const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(`kalilinux/packages/${name}`)}`;
    const res = await httpGetJson<any>(url, this.http);
    if (!res.ok) return failFromHttp(res, `Kali package "${name}"`);
    if (typeof res.json?.path !== 'string') return notFound('unexpected_response', 'Kali GitLab API: unexpected body', url);
    const base = assessEvidence(profile, { name, text: String(res.json.description ?? '') });
    if (!base) return notFound('not_found', `Kali package "${name}" does not match the tool`, url);
    // Kali's package set is a curated security-tool distribution, so an exact-name project there is
    // itself domain evidence — the one place a bare name match is upgraded, and it says why.
    const evidence: Evidence = base.level === 'name-only'
      ? { level: 'domain', reasons: ['exact-name package in the Kali Linux package set (a security-focused distribution)'] }
      : base;
    const webUrl = String(res.json.web_url ?? `https://gitlab.com/kalilinux/packages/${name}`);
    return {
      found: true, url: webUrl,
      data: {
        distro: 'kali', sourcePackage: name, binaries: [], installPackage: name,
        installCommand: `sudo apt install ${name}`, description: String(res.json.description ?? '') || undefined,
        evidence, url: webUrl, sources: [url],
      },
    };
  }

  /**
   * Looks the tool up (under its name and GitHub repo name) in Debian, Ubuntu and Kali in
   * parallel. A Debian package whose control file points at the registered GitHub repo is
   * the strongest evidence; Ubuntu (which syncs from Debian) inherits it when the source
   * names match. Anything that only shares a name is reported as `unverified`, never as the answer.
   */
  async resolve(profile: ToolProfile): Promise<Lookup<AptResolution>> {
    const names = profile.aliases.filter(n => SAFE_NAME_RE.test(n));
    if (names.length === 0) return notFound('invalid_input', `"${profile.name}" is not a valid apt package name`);

    const results = (await Promise.all(names.flatMap(n => [this.debian(profile, n), this.ubuntu(profile, n), this.kali(profile, n)]))).flat();
    const hits: AptHit[] = [];
    const soft: Array<{ reason: 'rate_limited' | 'network_error' | 'unexpected_response'; detail: string; retryAfterMs?: number }> = [];
    const checked: string[] = [];
    const ubuntuUnchecked: string[] = [];
    results.forEach((r, i) => {
      const isUbuntu = i % 3 === 1; // flatMap order above: debian, ubuntu, kali per name
      if (r.found) { hits.push(r.data); checked.push(...r.data.sources); return; }
      if (r.url) checked.push(r.url);
      if (r.reason === 'not_found' || r.reason === 'invalid_input') return;
      if (isUbuntu) ubuntuUnchecked.push(r.detail); // optional corroboration: noted, never decisive
      else soft.push(r as any);
    });

    // Ubuntu syncs from Debian by source name: if Debian's same-named package is verified, so is Ubuntu's.
    const groundedDebian = hits.filter(h => h.distro === 'debian' && isGrounded(h.evidence));
    for (const h of hits) {
      if (h.distro === 'ubuntu' && !isGrounded(h.evidence)) {
        const twin = groundedDebian.find(d => d.sourcePackage === h.sourcePackage);
        if (twin) {
          h.evidence = { level: 'domain', reasons: [`same source package name as the verified Debian package (${twin.evidence.reasons[0]})`] };
          h.installPackage = twin.installPackage;
          h.installCommand = twin.installCommand;
          h.binaries = twin.binaries;
        }
      }
    }

    const order = { strong: 0, domain: 1, 'name-only': 2 } as const;
    const rank = (h: AptHit) => order[h.evidence.level] * 10 + { debian: 0, kali: 1, ubuntu: 2 }[h.distro];
    const grounded = hits.filter(h => isGrounded(h.evidence)).sort((a, b) => rank(a) - rank(b));
    const unverified = hits.filter(h => !isGrounded(h.evidence));

    if (grounded.length === 0) {
      if (unverified.length > 0) {
        const hints: GroundingHint[] = unverified.map(h => ({
          label: `${h.distro}: ${h.sourcePackage}`, url: h.url, description: h.description,
          why: `a ${h.distro} package has this name but nothing links it to ${profile.github?.url ?? 'the registered tool'}`,
        }));
        return notFound('unverified', `${unverified.length} apt package(s) share the name "${profile.name}" but none could be tied to the registered tool`, undefined, undefined, hints);
      }
      if (soft.length > 0) {
        const f = soft[0];
        return notFound(f.reason, `could not verify apt packages for "${profile.name}": ${f.detail}`, undefined, f.retryAfterMs);
      }
      return notFound('not_found', `no Debian or Kali source package named "${names.join('" or "')}"${ubuntuUnchecked.length ? ' (Ubuntu was not checked: its API timed out)' : ' (Ubuntu also has none)'}`);
    }

    return { found: true, url: grounded[0].url, data: { best: grounded[0], hits: grounded, unverified, checked: [...new Set(checked)] } };
  }
}
