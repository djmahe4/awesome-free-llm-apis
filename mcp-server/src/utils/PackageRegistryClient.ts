import { httpGetJson, type HttpOptions } from './http.js';
import { failFromHttp, type Lookup } from './grounding.js';
import type { Dependency, Ecosystem } from './RepoManifests.js';

export interface PackageInfo {
  ecosystem: Ecosystem;
  name: string;
  latest?: string;
  description?: string;
  homepage?: string;
  license?: string;
  url: string;
}

const MAX_ENRICH = 12;
const CONCURRENCY = 4;

export class PackageRegistryClient {
  constructor(private readonly http: HttpOptions = {}) {}

  async lookup(ecosystem: Ecosystem, name: string): Promise<Lookup<PackageInfo>> {
    switch (ecosystem) {
      case 'npm': return this.npm(name);
      case 'pypi': return this.pypi(name);
      case 'go': return this.go(name);
      case 'cargo': return this.cargo(name);
    }
  }

  private async npm(name: string): Promise<Lookup<PackageInfo>> {
    // Scoped names keep their "@" and encode only the slash.
    const res = await httpGetJson<any>(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, this.http);
    if (!res.ok || !res.json) return failFromHttp(res, `npm ${name}`);
    const j = res.json;
    return { found: true, url: `https://www.npmjs.com/package/${name}`, data: {
      ecosystem: 'npm', name, latest: j.version, description: j.description, homepage: j.homepage,
      license: typeof j.license === 'string' ? j.license : undefined, url: `https://www.npmjs.com/package/${name}` } };
  }

  private async pypi(name: string): Promise<Lookup<PackageInfo>> {
    const res = await httpGetJson<any>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, this.http);
    if (!res.ok || !res.json?.info) return failFromHttp(res, `PyPI ${name}`);
    const i = res.json.info;
    return { found: true, url: i.package_url ?? `https://pypi.org/project/${name}/`, data: {
      ecosystem: 'pypi', name, latest: i.version, description: i.summary,
      homepage: i.home_page || i.project_urls?.Homepage || undefined, license: i.license || undefined,
      url: i.package_url ?? `https://pypi.org/project/${name}/` } };
  }

  private async go(mod: string): Promise<Lookup<PackageInfo>> {
    // proxy.golang.org requires upper-case letters escaped as !lower.
    const esc = mod.replace(/[A-Z]/g, c => '!' + c.toLowerCase());
    const res = await httpGetJson<any>(`https://proxy.golang.org/${esc}/@latest`, this.http);
    if (!res.ok || !res.json) return failFromHttp(res, `Go module ${mod}`);
    return { found: true, url: `https://pkg.go.dev/${mod}`, data: {
      ecosystem: 'go', name: mod, latest: res.json.Version, url: `https://pkg.go.dev/${mod}` } };
  }

  private async cargo(name: string): Promise<Lookup<PackageInfo>> {
    const res = await httpGetJson<any>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, this.http);
    if (!res.ok || !res.json?.crate) return failFromHttp(res, `crate ${name}`);
    const c = res.json.crate;
    return { found: true, url: `https://crates.io/crates/${name}`, data: {
      ecosystem: 'cargo', name, latest: c.max_stable_version ?? c.max_version, description: c.description,
      homepage: c.homepage || c.repository || undefined, url: `https://crates.io/crates/${name}` } };
  }

  /**
   * Describes up to MAX_ENRICH direct (non-dev) dependencies. Dependencies that cannot be
   * described are reported in `unresolved` with the reason — never dropped silently.
   */
  async enrich(deps: Dependency[]): Promise<{ described: PackageInfo[]; unresolved: { name: string; reason: string }[]; skipped: number }> {
    const direct = deps.filter(d => !d.dev);
    const picked = direct.slice(0, MAX_ENRICH);
    const described: PackageInfo[] = [];
    const unresolved: { name: string; reason: string }[] = [];
    for (let i = 0; i < picked.length; i += CONCURRENCY) {
      await Promise.all(picked.slice(i, i + CONCURRENCY).map(async d => {
        const r = await this.lookup(d.ecosystem, d.name);
        if (r.found) described.push(r.data); else unresolved.push({ name: d.name, reason: r.reason });
      }));
    }
    described.sort((a, b) => a.name.localeCompare(b.name));
    return { described, unresolved, skipped: direct.length - picked.length };
  }
}
