import { describe, it, expect } from 'vitest';
import { isPrivateAddress, checkPublicHttpUrl } from '../src/utils/ssrf-guard.js';

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fdab:1234::1', 'fe80::1', 'fe90::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1',
  ])('%s is private', ip => { expect(isPrivateAddress(ip)).toBe(true); });

  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.2.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8',
  ])('%s is public', ip => { expect(isPrivateAddress(ip)).toBe(false); });

  it('treats an unparsable address as private (fail closed)', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

const resolveTo = (map: Record<string, string[]>) => async (host: string) => {
  if (!map[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return map[host];
};

describe('checkPublicHttpUrl', () => {
  const pub = resolveTo({ 'example.com': ['93.184.216.34'], 'evil.test': ['10.0.0.5'], 'mixed.test': ['93.184.216.34', '127.0.0.1'] });

  it('accepts a public http(s) URL', async () => {
    const r = await checkPublicHttpUrl('https://example.com/a?b=1', { resolve: pub });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['file:///etc/passwd', 'BAD_SCHEME'],
    ['javascript:alert(1)', 'BAD_SCHEME'],
    ['chrome://settings', 'BAD_SCHEME'],
    ['ftp://example.com/x', 'BAD_SCHEME'],
    ['data:text/html,hi', 'BAD_SCHEME'],
    ['not a url', 'BAD_URL'],
    ['', 'BAD_URL'],
  ])('rejects %s as %s', async (url, code) => {
    const r = await checkPublicHttpUrl(url, { resolve: pub });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it.each([
    'http://127.0.0.1/', 'http://localhost/', 'http://LOCALHOST:8080/', 'http://foo.localhost/', 'http://[::1]/', 'http://192.168.254.1/',
    'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://0/', 'http://10.0.0.1/', 'http://192.168.0.1/', 'http://100.64.0.1/',
    'http://[fe80::1]/', 'http://[fdab::1]/', 'http://[::ffff:127.0.0.1]/', 'http://metadata.google.internal/', 'http://intranet.internal/', 'http://printer.local/',
  ])('rejects private target %s', async (url) => {
    const r = await checkPublicHttpUrl(url, { resolve: pub });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PRIVATE_ADDRESS');
  });

  it('rejects a public-looking hostname that resolves to a private address (DNS rebinding / split horizon)', async () => {
    const r = await checkPublicHttpUrl('https://evil.test/', { resolve: pub });
    expect(r).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
  });

  it('rejects when ANY resolved address is private', async () => {
    const r = await checkPublicHttpUrl('https://mixed.test/', { resolve: pub });
    expect(r).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
  });

  it('reports an unresolvable host as DNS_FAILED, not as allowed', async () => {
    const r = await checkPublicHttpUrl('https://nope.invalid/', { resolve: pub });
    expect(r).toMatchObject({ ok: false, code: 'DNS_FAILED' });
  });

  it('rejects URLs with embedded credentials', async () => {
    const r = await checkPublicHttpUrl('https://user:pw@example.com/', { resolve: pub });
    expect(r).toMatchObject({ ok: false, code: 'CREDENTIALS_IN_URL' });
  });

  it('allowPrivate opt-in permits private targets but still enforces the scheme', async () => {
    expect((await checkPublicHttpUrl('http://127.0.0.1:3000/', { resolve: pub, allowPrivate: true })).ok).toBe(true);
    expect((await checkPublicHttpUrl('file:///etc/passwd', { resolve: pub, allowPrivate: true })).ok).toBe(false);
  });
});

describe('allowHosts (explicit local-testing allowlist)', () => {
  const pub = async (h: string) => (h === 'example.com' ? ['93.184.216.34'] : []);

  it('permits exactly the listed host:port and nothing else on loopback', async () => {
    const opts = { resolve: pub, allowHosts: ['localhost:3111', '127.0.0.1:8080'] };
    expect((await checkPublicHttpUrl('http://localhost:3111/dashboard', opts)).ok).toBe(true);
    expect((await checkPublicHttpUrl('http://127.0.0.1:8080/', opts)).ok).toBe(true);
    expect(await checkPublicHttpUrl('http://localhost:9999/', opts)).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
    expect(await checkPublicHttpUrl('http://127.0.0.1:3111/', opts)).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
    expect(await checkPublicHttpUrl('http://10.0.0.1:3111/', opts)).toMatchObject({ ok: false, code: 'PRIVATE_ADDRESS' });
  });

  it('a bare host entry matches any port of that host', async () => {
    const opts = { resolve: pub, allowHosts: ['localhost'] };
    expect((await checkPublicHttpUrl('http://localhost:5173/', opts)).ok).toBe(true);
    expect((await checkPublicHttpUrl('http://localhost/', opts)).ok).toBe(true);
    expect(await checkPublicHttpUrl('http://127.0.0.1:5173/', opts)).toMatchObject({ ok: false });
  });

  it('IPv6 loopback can be listed', async () => {
    expect((await checkPublicHttpUrl('http://[::1]:3000/', { resolve: pub, allowHosts: ['[::1]:3000'] })).ok).toBe(true);
  });

  it('cloud metadata addresses stay blocked even when listed or when allowPrivate is on', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/']) {
      expect(await checkPublicHttpUrl(url, { resolve: pub, allowHosts: ['169.254.169.254', '[fd00:ec2::254]'] })).toMatchObject({ ok: false, code: 'METADATA_ADDRESS' });
      expect(await checkPublicHttpUrl(url, { resolve: pub, allowPrivate: true })).toMatchObject({ ok: false, code: 'METADATA_ADDRESS' });
    }
  });

  it('the scheme is still enforced for allowlisted hosts', async () => {
    expect(await checkPublicHttpUrl('file://localhost/etc/passwd', { resolve: pub, allowHosts: ['localhost'] })).toMatchObject({ ok: false, code: 'BAD_SCHEME' });
  });
});
