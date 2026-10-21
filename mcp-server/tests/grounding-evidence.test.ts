import { describe, it, expect } from 'vitest';
import { assessEvidence, buildToolProfile, isGrounded, CYBER_DOMAIN_RE } from '../src/utils/groundingEvidence.js';

// Fixtures are verbatim from live Docker Hub / sources.debian.org responses.
const hydra = buildToolProfile('hydra', 'https://github.com/vanhauser-thc/thc-hydra');
const nmap = buildToolProfile('nmap', 'https://github.com/nmap/nmap');
const sqlmap = buildToolProfile('sqlmap', 'https://github.com/sqlmapproject/sqlmap');
const httpx = buildToolProfile('httpx', 'https://github.com/projectdiscovery/httpx');

describe('buildToolProfile', () => {
  it('derives the github identity and a repo-name alias', () => {
    expect(hydra).toMatchObject({ name: 'hydra', aliases: ['hydra', 'thc-hydra'], github: { owner: 'vanhauser-thc', repo: 'thc-hydra' } });
    expect(nmap.aliases).toEqual(['nmap']); // repo name == tool name, no extra alias
  });
  it('tolerates a missing / non-github url and a .git suffix', () => {
    expect(buildToolProfile('x').github).toBeUndefined();
    expect(buildToolProfile('x', 'https://example.com/x').github).toBeUndefined();
    expect(buildToolProfile('x', 'https://github.com/o/r.git').github?.repo).toBe('r');
  });
});

describe('assessEvidence — the homonym the live run exposed', () => {
  it('does NOT ground oryd/hydra (an OAuth2 server) as the registry\'s THC-Hydra', () => {
    const ev = assessEvidence(hydra, {
      name: 'hydra', owner: 'oryd',
      text: 'Scalable, security first OAuth 2.0 and OpenID Connect server Please check out the [ORY Hydra Documentation](https://www.ory.com/hydra/docs/) for more information and details about using this image.',
    });
    expect(ev?.level).toBe('name-only');
    expect(isGrounded(ev)).toBe(false);
  });

  it('grounds Debian\'s hydra: its control Homepage IS the registered GitHub repo', () => {
    const ev = assessEvidence(hydra, { name: 'hydra', homepage: 'https://github.com/vanhauser-thc/thc-hydra', text: 'very fast network logon cracker' });
    expect(ev?.level).toBe('strong');
    expect(ev?.reasons[0]).toMatch(/homepage is the registered GitHub repo/);
  });

  it('grounds an image named after the github repo (thc-hydra) even from another publisher', () => {
    expect(assessEvidence(hydra, { name: 'thc-hydra', owner: 'someone', text: '' })?.level).toBe('strong');
  });
});

describe('assessEvidence — other levels', () => {
  it('grounds instrumentisto/nmap on security wording even though it links its packaging repo, not upstream', () => {
    const ev = assessEvidence(nmap, { name: 'nmap', owner: 'instrumentisto', text: 'Nmap ("Network Mapper") Docker Image [![Release](https://img.shields.io/github/v/release/instrumentisto/nmap-docker-image)](https://github.com/instrumentisto/nmap-docker-image/releases)' });
    expect(ev?.level).toBe('domain');
    expect(isGrounded(ev)).toBe(true);
  });

  it('does not let a look-alike github path (nmap-docs) count as the registered repo', () => {
    const ev = assessEvidence(nmap, { name: 'nmap', owner: 'x', text: 'see https://github.com/nmap/nmap-docs for docs' });
    expect(ev?.level).toBe('name-only');
  });

  it('grounds Debian nmap / sqlmap via their own descriptions', () => {
    expect(assessEvidence(nmap, { name: 'nmap', homepage: 'https://nmap.org/', text: 'The Network Mapper' })?.level).toBe('domain');
    expect(assessEvidence(sqlmap, { name: 'sqlmap', homepage: 'https://sqlmap.org/', text: 'automatic SQL injection tool' })?.level).toBe('domain');
  });

  it('treats the same github owner as strong (projectdiscovery/httpx), and a python HTTP client of the same name as name-only', () => {
    expect(assessEvidence(httpx, { name: 'httpx', owner: 'projectdiscovery', text: 'fast and multi-purpose HTTP toolkit' })?.level).toBe('strong');
    expect(assessEvidence(httpx, { name: 'httpx', owner: 'encode', text: 'A next generation HTTP client for Python' })?.level).toBe('name-only');
  });

  it('returns null when nothing ties the candidate to the tool at all', () => {
    expect(assessEvidence(nmap, { name: 'webserver', owner: 'acme', text: 'a web server that mentions nmap once' })).toBeNull();
  });
});

describe('CYBER_DOMAIN_RE', () => {
  it('matches specific tool vocabulary', () => {
    for (const t of ['port scanner', 'network mapper', 'SQL injection tool', 'password cracker', 'web fuzzer', 'subdomain enumeration', 'penetration testing framework', 'OSINT toolkit']) {
      expect(CYBER_DOMAIN_RE.test(t)).toBe(true);
    }
  });
  it('does NOT match generic words that appear in non-security software', () => {
    for (const t of ['security first OAuth 2.0 server', 'password manager', 'network proxy', 'HTTP client for Python', 'authentication service']) {
      expect(CYBER_DOMAIN_RE.test(t)).toBe(false);
    }
  });
});
