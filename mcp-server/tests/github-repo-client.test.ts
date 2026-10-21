import { describe, it, expect } from 'vitest';
import { GithubRepoClient, extractUsage } from '../src/utils/GithubRepoClient.js';
import { PackageRegistryClient } from '../src/utils/PackageRegistryClient.js';
import { parseManifest, parseGoMod, parsePyproject, parseRequirementsTxt, parseCargoToml } from '../src/utils/RepoManifests.js';
import { mockFetch, type MockRoute } from './helpers/mock-fetch.js';

const opts = (routes: MockRoute[]) => { const m = mockFetch(routes); return { m, o: { fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 0 } }; };

describe('manifest parsers', () => {
  it('package.json: deps + devDeps, own name', () => {
    const m = parseManifest('package.json', JSON.stringify({ name: 'x', dependencies: { a: '^1' }, devDependencies: { b: '2' } }))!;
    expect(m.packageName).toBe('x');
    expect(m.dependencies.map(d => [d.name, d.dev])).toEqual([['a', false], ['b', true]]);
  });
  it('malformed package.json yields null, not a throw', () => {
    expect(parseManifest('package.json', '{nope')).toBeNull();
  });
  it('requirements.txt skips comments, flags, URLs; keeps specs and extras', () => {
    const m = parseRequirementsTxt('requirements.txt', '# c\n-r other.txt\nrequests>=2.0  # inline\nuvicorn[standard]==0.3\ngit+https://x/y.git\nflask ; python_version>"3"\n');
    expect(m.dependencies.map(d => [d.name, d.spec])).toEqual([['requests', '>=2.0'], ['uvicorn', '==0.3'], ['flask', undefined]]);
  });
  it('pyproject: PEP 621 and poetry (python itself excluded)', () => {
    const pep = parsePyproject('pyproject.toml', '[project]\nname = "tool"\ndependencies = [\n  "httpx>=0.2",\n  "rich",\n]\n')!;
    expect(pep.packageName).toBe('tool');
    expect(pep.dependencies.map(d => d.name)).toEqual(['httpx', 'rich']);
    const poe = parsePyproject('pyproject.toml', '[tool.poetry]\nname="p"\n[tool.poetry.dependencies]\npython = "^3.9"\nclick = "^8"\nrich = { version = "^13" }\n[tool.poetry.dev-dependencies]\npytest="*"\n')!;
    expect(poe.dependencies.map(d => [d.name, d.spec])).toEqual([['click', '^8'], ['rich', '^13']]);
  });
  it('go.mod: block and single-line requires; indirect marked dev', () => {
    const m = parseGoMod('go.mod', 'module github.com/o/r\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.1.0 // indirect\n)\nrequire github.com/e/f v2.0.0\n');
    expect(m.packageName).toBe('github.com/o/r');
    expect(m.dependencies.map(d => [d.name, d.dev])).toEqual([['github.com/a/b', false], ['github.com/c/d', true], ['github.com/e/f', false]]);
  });
  it('Cargo.toml: string and table versions', () => {
    const m = parseCargoToml('Cargo.toml', '[package]\nname = "c"\n[dependencies]\nserde = "1"\ntokio = { version = "1.2", features = ["full"] }\n[dev-dependencies]\ncriterion = "0.5"\n')!;
    expect(m.packageName).toBe('c');
    expect(m.dependencies.map(d => [d.name, d.spec, d.dev])).toEqual([['serde', '1', false], ['tokio', '1.2', false], ['criterion', '0.5', true]]);
  });
});

describe('extractUsage', () => {
  it('sorts code blocks by the heading they sit under', () => {
    const r = extractUsage('# T\n## Installation\n```bash\npip install x\n```\n## Usage\n```\nx --help\n```\n## License\n```\nignored\n```\n');
    expect(r).toEqual({ install: ['pip install x'], run: ['x --help'] });
  });
});

describe('GithubRepoClient', () => {
  const meta = { full_name: 'o/r', description: 'd', default_branch: 'dev', stargazers_count: 7, topics: ['a'], html_url: 'https://github.com/o/r', license: { spdx_id: 'MIT' } };
  const tree = { truncated: false, tree: [
    { type: 'blob', path: 'README.md' }, { type: 'blob', path: 'package.json' }, { type: 'blob', path: 'sub/requirements.txt' },
    { type: 'blob', path: '.claude/skills/alpha/SKILL.md' }, { type: 'blob', path: '.claude/skills/beta/SKILL.md' },
    { type: 'blob', path: '.mcp.json' }, { type: 'blob', path: 'mcp_server/__init__.py' }, { type: 'tree', path: 'mcp_server' },
  ] };

  it('reads the default branch (not main/master), manifests, skills, mcp files and README usage', async () => {
    const { m, o } = opts([
      { match: 'api.github.com/repos/o/r/git/trees/dev', body: tree },
      { match: 'api.github.com/repos/o/r', body: meta },
      { match: 'raw.githubusercontent.com/o/r/dev/README.md', body: '## Install\n```\nnpm i r\n```\n' },
      { match: 'raw.githubusercontent.com/o/r/dev/package.json', body: JSON.stringify({ name: 'r', dependencies: { left: '1' } }) },
      { match: 'raw.githubusercontent.com/o/r/dev/sub/requirements.txt', body: 'requests\n' },
    ]);
    const r = await new GithubRepoClient(o).understand('o', 'r');
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data.meta).toMatchObject({ defaultBranch: 'dev', stars: 7, license: 'MIT' });
    expect(r.data.dependencies.map(d => `${d.ecosystem}:${d.name}`).sort()).toEqual(['npm:left', 'pypi:requests']);
    expect(r.data.skills).toMatchObject({ total: 2, roots: ['.claude/skills'] });
    expect(r.data.skills.samples.map(s => s.name)).toEqual(['alpha', 'beta']);
    expect(r.data.mcp.configFiles).toEqual(['.mcp.json']);
    expect(r.data.mcp.serverFiles).toEqual(['mcp_server/__init__.py']);
    expect(r.data.usage.install).toEqual(['npm i r']);
    expect(m.calls.some(u => /\/(main|master)\//.test(u))).toBe(false);
  });

  it('unknown repo → not_found (definitive), not an error', async () => {
    const { o } = opts([{ match: 'api.github.com', status: 404, body: { message: 'Not Found' } }]);
    expect(await new GithubRepoClient(o).understand('o', 'gone')).toMatchObject({ found: false, reason: 'not_found' });
  });

  it('exhausted unauthenticated quota → rate_limited, never "not found"', async () => {
    const { o } = opts([{ match: 'api.github.com', status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60' }, body: { message: 'rate limit' } }]);
    expect(await new GithubRepoClient(o).understand('o', 'r')).toMatchObject({ found: false, reason: 'rate_limited' });
  });

  it('tree failure degrades with an explicit note instead of silently returning nothing', async () => {
    const { o } = opts([
      { match: 'git/trees', status: 500, body: 'x' },
      { match: 'api.github.com/repos/o/r', body: meta },
      { match: 'raw.githubusercontent.com', body: '# hi' },
    ]);
    const r = await new GithubRepoClient(o).understand('o', 'r');
    expect(r.found).toBe(true);
    if (r.found) expect(r.data.notes.join(' ')).toMatch(/File tree unavailable/);
  });
});

describe('PackageRegistryClient', () => {
  it('describes npm/pypi/go/cargo packages and reports unresolved ones with a reason', async () => {
    const { m, o } = opts([
      { match: 'registry.npmjs.org/@s%2Fp/latest', body: { version: '1.0.0', description: 'scoped', license: 'MIT' } },
      { match: 'pypi.org/pypi/requests/json', body: { info: { version: '2.0', summary: 'http', package_url: 'https://pypi.org/project/requests/' } } },
      { match: 'proxy.golang.org/github.com/!azure/x/@latest', body: { Version: 'v1.1.0' } },
      { match: 'crates.io/api/v1/crates/serde', body: { crate: { max_stable_version: '1.0.1', description: 'ser' } } },
      { match: 'registry.npmjs.org', status: 404, body: {} },
    ]);
    const c = new PackageRegistryClient(o);
    const r = await c.enrich([
      { name: '@s/p', ecosystem: 'npm', source: 'p' }, { name: 'requests', ecosystem: 'pypi', source: 'r' },
      { name: 'github.com/Azure/x', ecosystem: 'go', source: 'g' }, { name: 'serde', ecosystem: 'cargo', source: 'c' },
      { name: 'ghost', ecosystem: 'npm', source: 'p' }, { name: 'devonly', ecosystem: 'npm', dev: true, source: 'p' },
    ]);
    expect(r.described.map(d => d.name)).toEqual(['@s/p', 'github.com/Azure/x', 'requests', 'serde']);
    expect(r.unresolved).toEqual([{ name: 'ghost', reason: 'not_found' }]);
    expect(m.calls.some(u => u.includes('devonly'))).toBe(false);
  });

  it('caps enrichment and says how many it skipped', async () => {
    const { o } = opts([{ match: '', body: { version: '1' } }]);
    const deps = Array.from({ length: 15 }, (_, i) => ({ name: `p${i}`, ecosystem: 'npm' as const, source: 'p' }));
    expect((await new PackageRegistryClient(o).enrich(deps)).skipped).toBe(3);
  });
});
