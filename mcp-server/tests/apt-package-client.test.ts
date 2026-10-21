import { describe, it, expect } from 'vitest';
import { AptPackageClient, parseControl, pickInstallPackage } from '../src/utils/AptPackageClient.js';
import { buildToolProfile } from '../src/utils/groundingEvidence.js';
import { mockFetch, type MockRoute } from './helpers/mock-fetch.js';

const client = (routes: MockRoute[]) => {
  const m = mockFetch(routes);
  return { m, c: new AptPackageClient({ fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 0 }) };
};

// Verbatim shape of sources.debian.org / gitlab / launchpad responses seen live.
const HYDRA_CONTROL = [
  'Source: hydra', 'Section: net', 'Homepage: https://github.com/vanhauser-thc/thc-hydra', '',
  'Package: hydra', 'Architecture: any', 'Description: very fast network logon cracker', ' Hydra is a parallelized login cracker', ' which supports numerous protocols.', '',
  'Package: hydra-gtk', 'Architecture: any', 'Description: very fast network logon cracker - GTK+ GUI', ' GTK frontend.', '',
].join('\n');
const NMAP_CONTROL = ['Source: nmap', 'Homepage: https://nmap.org/', '', 'Package: nmap', 'Description: The Network Mapper', '', 'Package: nmap-common', 'Description: Architecture independent files for nmap', '', 'Package: ncat', 'Description: NMAP netcat reimplementation', ''].join('\n');

const debianSrc = (pkg: string, version: string) => ({ package: pkg, path: pkg, type: 'directory', versions: [{ area: 'main', suites: ['forky', 'sid'], version }] });
const hydra = buildToolProfile('hydra', 'https://github.com/vanhauser-thc/thc-hydra');
const nmap = buildToolProfile('nmap', 'https://github.com/nmap/nmap');

describe('parseControl', () => {
  it('reads Homepage from the Source stanza and every binary package with its synopsis', () => {
    expect(parseControl(HYDRA_CONTROL)).toEqual({
      homepage: 'https://github.com/vanhauser-thc/thc-hydra',
      binaries: [
        { package: 'hydra', description: 'very fast network logon cracker' },
        { package: 'hydra-gtk', description: 'very fast network logon cracker - GTK+ GUI' },
      ],
    });
  });
  it('handles CRLF and a file with no binaries', () => {
    expect(parseControl('Source: x\r\nHomepage: https://x.test\r\n').binaries).toEqual([]);
    expect(parseControl('Source: x\r\nHomepage: https://x.test\r\n').homepage).toBe('https://x.test');
  });
});

describe('pickInstallPackage', () => {
  it('prefers the binary named like the tool, then a non-doc/dev one, then the fallback', () => {
    expect(pickInstallPackage(nmap, ['nmap-common', 'nmap', 'ncat'], 'x')).toBe('nmap');
    expect(pickInstallPackage(hydra, ['hydra-gtk', 'hydra'], 'x')).toBe('hydra');
    expect(pickInstallPackage(buildToolProfile('foo'), ['foo-doc', 'foo-bin'], 'x')).toBe('foo-bin');
    expect(pickInstallPackage(buildToolProfile('foo'), [], 'fallback')).toBe('fallback');
  });
});

describe('AptPackageClient.resolve', () => {
  it('grounds Debian hydra: control Homepage IS the registered github repo, and install uses a REAL binary name', async () => {
    const { c, m } = client([
      { match: 'sources.debian.org/api/src/hydra/', body: debianSrc('hydra', '9.7-2') },
      { match: 'sources.debian.org/api/src/thc-hydra/', body: { error: 404 } },
      { match: 'sources.debian.org/data/main/h/hydra/9.7-2/debian/control', body: HYDRA_CONTROL },
      { match: 'api.launchpad.net/devel/ubuntu/+source/hydra', body: { name: 'hydra', web_link: 'https://launchpad.net/ubuntu/+source/hydra' } },
      { match: 'api.launchpad.net', status: 404, body: 'Object: <Distribution>, name: nope' },
      { match: 'kalilinux%2Fpackages%2Fhydra', body: { path: 'hydra', description: 'hydra packaging for Kali Linux', web_url: 'https://gitlab.com/kalilinux/packages/hydra' } },
      { match: 'gitlab.com', status: 404, body: { message: '404 Project Not Found' } },
    ]);
    const r = await c.resolve(hydra);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data.best).toMatchObject({ distro: 'debian', installPackage: 'hydra', installCommand: 'sudo apt install hydra', version: '9.7-2', homepage: 'https://github.com/vanhauser-thc/thc-hydra' });
    expect(r.data.best.evidence.level).toBe('strong');
    expect(r.data.best.binaries).toEqual(['hydra', 'hydra-gtk']);
    expect(r.data.hits.map(h => h.distro).sort()).toEqual(['debian', 'kali', 'ubuntu']);
    expect(m.calls.some(u => u.endsWith('/debian/control'))).toBe(true);
  });

  it('Ubuntu inherits Debian\'s verification (and its real binary name) when the source names match', async () => {
    const { c } = client([
      { match: 'sources.debian.org/api/src/nmap/', body: debianSrc('nmap', '7.991+dfsg-1') },
      { match: 'debian/control', body: NMAP_CONTROL },
      { match: 'api.launchpad.net/devel/ubuntu/+source/nmap', body: { name: 'nmap' } },
      { match: 'gitlab.com', status: 404, body: {} },
    ]);
    const r = await c.resolve(nmap);
    expect(r.found).toBe(true);
    if (!r.found) return;
    const ubuntu = r.data.hits.find(h => h.distro === 'ubuntu')!;
    expect(ubuntu.evidence.level).toBe('domain');
    expect(ubuntu.evidence.reasons[0]).toMatch(/same source package name as the verified Debian package/);
    expect(ubuntu.installPackage).toBe('nmap');
    expect(r.data.best.distro).toBe('debian');
  });

  it('treats Debian\'s HTTP-200 {"error":404} as NOT FOUND, not as a hit', async () => {
    const { c } = client([
      { match: 'sources.debian.org', body: { error: 404 } },
      { match: 'launchpad', status: 404, body: 'nope' },
      { match: 'gitlab.com', status: 404, body: {} },
    ]);
    expect(await c.resolve(buildToolProfile('zzz-no-tool'))).toMatchObject({ found: false, reason: 'not_found' });
  });

  it('a binary-only name (ncat is built from nmap) is honestly not found as a source package', async () => {
    const { c } = client([
      { match: 'sources.debian.org', body: { error: 404 } },
      { match: 'launchpad', status: 404, body: 'x' },
      { match: 'gitlab.com', status: 404, body: {} },
    ]);
    expect(await c.resolve(buildToolProfile('ncat'))).toMatchObject({ found: false, reason: 'not_found' });
  });

  it('Kali alone is enough: an exact-name package in Kali is domain evidence, and says why', async () => {
    const { c } = client([
      { match: 'sources.debian.org', body: { error: 404 } },
      { match: 'launchpad', status: 404, body: 'x' },
      { match: 'kalilinux%2Fpackages%2Fhexstrike-ai', body: { path: 'hexstrike-ai', description: 'hexstrike-ai packaging for Kali Linux', web_url: 'https://gitlab.com/kalilinux/packages/hexstrike-ai' } },
      { match: 'gitlab.com', status: 404, body: {} },
    ]);
    const r = await c.resolve(buildToolProfile('hexstrike-ai', 'https://github.com/0x4m4/hexstrike-ai'));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data.best).toMatchObject({ distro: 'kali', installCommand: 'sudo apt install hexstrike-ai' });
    expect(r.data.best.evidence.reasons[0]).toMatch(/Kali Linux package set/);
  });

  it('a same-named Debian package whose metadata does not identify the tool is unverified, not the answer', async () => {
    const { c } = client([
      { match: 'sources.debian.org/api/src/httpx/', body: debianSrc('httpx', '1.0-1') },
      { match: 'debian/control', body: 'Source: httpx\nHomepage: https://www.python-httpx.org/\n\nPackage: python3-httpx\nDescription: next generation HTTP client for Python\n' },
      { match: 'launchpad', status: 404, body: 'x' },
      { match: 'gitlab.com', status: 404, body: {} },
    ]);
    const r = await c.resolve(buildToolProfile('httpx', 'https://github.com/projectdiscovery/httpx'));
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.reason).toBe('unverified');
    expect(r.hints?.[0].why).toContain('https://github.com/projectdiscovery/httpx');
  });

  it('keeps network/rate-limit reasons instead of claiming "not found" when every provider failed to answer', async () => {
    const { c } = client([{ match: '', throws: { message: 'getaddrinfo ENOTFOUND', code: 'ENOTFOUND' } }]);
    expect(await c.resolve(nmap)).toMatchObject({ found: false, reason: 'network_error' });
  });

  it('still returns Debian\'s hit (as unverified) if the control file is unavailable — existence is real, identity just can\'t be shown', async () => {
    const { c } = client([
      { match: 'sources.debian.org/api/src/nmap/', body: debianSrc('nmap', '7.991+dfsg-1') },
      { match: 'debian/control', status: 503 },
      { match: 'launchpad', status: 404, body: 'x' },
      { match: 'gitlab.com', status: 404, body: {} },
    ]);
    const r = await c.resolve(nmap);
    expect(r).toMatchObject({ found: false, reason: 'unverified' });
  });

  it('REGRESSION: reads debian/control for an epoch version (nikto is 1:2.1.5-3.1) instead of silently skipping it as name-only', async () => {
    const nikto = buildToolProfile('nikto', 'https://github.com/sullo/nikto');
    const { c, m } = client([
      { match: 'sources.debian.org/api/src/nikto/', body: { versions: [{ area: 'non-free', suites: ['sid'], version: '1:2.1.5-3.1' }] } },
      { match: 'debian/control', body: 'Source: nikto\nHomepage: http://cirt.net/nikto2\n\nPackage: nikto\nDescription: web server security scanner\n Nikto is a pluggable web server and CGI scanner.\n' },
      { match: 'launchpad', status: 404, body: 'x' },
      { match: 'gitlab.com', status: 404, body: {} },
    ]);
    const r = await c.resolve(nikto);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data.best).toMatchObject({ distro: 'debian', installPackage: 'nikto', version: '1:2.1.5-3.1' });
    expect(r.data.best.evidence.level).toBe('domain');
    expect(m.calls.some(u => u.includes('/non-free/n/nikto/1:2.1.5-3.1/debian/control'))).toBe(true);
  });

  it('a slow/failed Ubuntu lookup never turns a definitive Debian+Kali "not found" into a network error', async () => {
    const { c } = client([
      { match: 'sources.debian.org', body: { error: 404 } },
      { match: 'gitlab.com', status: 404, body: {} },
      { match: 'launchpad', throws: { name: 'TimeoutError', message: 'aborted' } },
    ]);
    const r = await c.resolve(buildToolProfile('phishkit-triage', 'https://github.com/trac3r00/phish-triage'));
    expect(r).toMatchObject({ found: false, reason: 'not_found' });
    if (!r.found) expect(r.detail).toContain('Ubuntu was not checked');
  });

  it('rejects an unusable name with no request at all', async () => {
    const { c, m } = client([{ match: '', body: {} }]);
    expect(await c.resolve(buildToolProfile('../../etc'))).toMatchObject({ found: false, reason: 'invalid_input' });
    expect(m.calls).toHaveLength(0);
  });
});
