import { describe, it, expect } from 'vitest';
import { AuditTaintBridge, type EcosystemAuditReport, type TaintedCallSite } from '../src/memory/audit-taint-bridge.js';

describe('AuditTaintBridge: Library-Based Taint Mapping Without Docs', () => {
  const bridge = new AuditTaintBridge();

  it('parses npm, cargo, and pip audit outputs into normalized vulnerability records', () => {
    // 1. npm audit format
    const mockNpmReport = {
      vulnerabilities: {
        tar: {
          severity: 'high',
          via: [{ title: 'Arbitrary File Overwrite', url: 'https://github.com/advisories/GHSA-1234' }],
          nodes: ['node_modules/tar'],
        },
      },
    };
    const parsedNpm = bridge.normalizeNpmAudit(mockNpmReport);
    expect(parsedNpm).toHaveLength(1);
    expect(parsedNpm[0].packageName).toBe('tar');
    expect(parsedNpm[0].severity).toBe('high');
    expect(parsedNpm[0].title).toBe('Arbitrary File Overwrite');

    // 2. cargo audit format
    const mockCargoReport = {
      vulnerabilities: {
        list: [
          {
            advisory: {
              id: 'RUSTSEC-2024-0001',
              package: 'openssl',
              title: 'Memory leak in SSL handshake',
              url: 'https://rustsec.org/advisories/RUSTSEC-2024-0001',
            },
            package: {
              name: 'openssl',
              version: '0.10.30',
            },
          },
        ],
      },
    };
    const parsedCargo = bridge.normalizeCargoAudit(mockCargoReport);
    expect(parsedCargo).toHaveLength(1);
    expect(parsedCargo[0].packageName).toBe('openssl');
    expect(parsedCargo[0].severity).toBe('high');
    expect(parsedCargo[0].title).toBe('Memory leak in SSL handshake');

    // 3. pip-audit format
    const mockPipReport = [
      {
        name: 'urllib3',
        version: '1.26.4',
        vulns: [
          {
            id: 'GHSA-q2q7-5pp4-w6pg',
            aliases: ['CVE-2021-33503'],
            fix_versions: ['1.26.5'],
            description: 'Catastrophic backtracking in URL parsing',
          },
        ],
      },
    ];
    const parsedPip = bridge.normalizePipAudit(mockPipReport);
    expect(parsedPip).toHaveLength(1);
    expect(parsedPip[0].packageName).toBe('urllib3');
    expect(parsedPip[0].title).toContain('Catastrophic backtracking');
  });

  it('correlates tainted dependencies with internal AST call sites in the DAG', () => {
    const internalCallSites = [
      { caller: 'src/archive/unpack.ts::extractAll', calleePackage: 'tar', calleeMethod: 'x', line: 42 },
      { caller: 'src/utils/log.ts::logInfo', calleePackage: 'pino', calleeMethod: 'info', line: 15 },
    ];

    const advisories = [
      { packageName: 'tar', severity: 'high', title: 'Arbitrary File Overwrite', advisoryId: 'GHSA-1234' },
    ];

    const taintedPaths = bridge.findTaintedCallSites(internalCallSites, advisories);
    expect(taintedPaths).toHaveLength(1);
    expect(taintedPaths[0].caller).toBe('src/archive/unpack.ts::extractAll');
    expect(taintedPaths[0].vulnerabilityTitle).toBe('Arbitrary File Overwrite');
    expect(taintedPaths[0].line).toBe(42);
    expect(taintedPaths[0].calleePackage).toBe('tar');
  });

  it('creates consent request for git clone --depth 1 when remote tree is inadequate', () => {
    const consent = bridge.createShallowClonePrompt(
      'https://github.com/org/repo',
      'cargo audit requires full lockfile tree'
    );
    expect(consent.action).toBe('prompt_user_consent');
    expect(consent.command).toBe('git clone --depth 1 https://github.com/org/repo');
    expect(consent.reason).toContain('cargo audit');
    expect(consent.requiresConfirmation).toBe(true);
  });

  it('validates repoUrl in createShallowClonePrompt and rejects invalid/unsafe URLs', () => {
    // Valid protocols
    expect(() => bridge.createShallowClonePrompt('https://github.com/org/repo.git', 'test')).not.toThrow();
    expect(() => bridge.createShallowClonePrompt('http://github.com/org/repo.git', 'test')).not.toThrow();
    expect(() => bridge.createShallowClonePrompt('git@github.com:org/repo.git', 'test')).not.toThrow();
    expect(() => bridge.createShallowClonePrompt('git://github.com/org/repo.git', 'test')).not.toThrow();

    // Invalid protocols
    expect(() => bridge.createShallowClonePrompt('ftp://github.com/org/repo', 'test')).toThrow('Invalid or unsafe repository URL');
    expect(() => bridge.createShallowClonePrompt('file:///etc/passwd', 'test')).toThrow('Invalid or unsafe repository URL');

    // Leading hyphen / option injection
    expect(() => bridge.createShallowClonePrompt('--upload-pack=calc.exe', 'test')).toThrow('Invalid or unsafe repository URL');
    expect(() => bridge.createShallowClonePrompt('-oProxyCommand=calc.exe', 'test')).toThrow('Invalid or unsafe repository URL');

    // Shell metacharacters injection
    const metaChars = [';', '&', '|', '`', '$', '\n', '\r', '>', '<'];
    for (const char of metaChars) {
      expect(() => bridge.createShallowClonePrompt(`https://github.com/org/repo${char}evil`, 'test')).toThrow(
        'Invalid or unsafe repository URL'
      );
    }
  });

  it('normalizes npm audit with array guard, URL validation, trailing slash trimming, and String ID wrapping', () => {
    // Array vulnerabilities returns []
    expect(bridge.normalizeNpmAudit({ vulnerabilities: [] })).toEqual([]);

    // URL with trailing slash, numeric id wrapping, non-string url
    const report = {
      vulnerabilities: {
        pkg1: {
          via: [{ id: 12345, url: 'https://github.com/advisories/GHSA-1234/' }],
        },
        pkg2: {
          url: 'https://example.com/advisories/SEC-999/',
        },
        pkg3: {
          url: { invalid: 'object' },
        },
      },
    };
    const parsed = bridge.normalizeNpmAudit(report);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].advisoryId).toBe('12345');
    expect(parsed[1].advisoryId).toBe('SEC-999');
    expect(parsed[2].url).toBeUndefined();
  });

  it('finds tainted call sites mapping across all matching advisories with type guards', () => {
    const internalSites = [
      { caller: 'src/app.ts', calleePackage: 'lodash', line: 10 },
      { caller: 'src/bad.ts', calleePackage: 123 as any, line: 20 },
      { caller: 'src/ok.ts', calleePackage: 'safe-pkg', line: 30 },
    ];

    const advisories = [
      { packageName: 'lodash', severity: 'high', title: 'Prototype Pollution 1', advisoryId: 'GHSA-1' },
      { packageName: 'lodash', severity: 'critical', title: 'Prototype Pollution 2', advisoryId: 'GHSA-2' },
      { packageName: null as any, severity: 'low', title: 'Invalid' },
    ];

    const tainted = bridge.findTaintedCallSites(internalSites, advisories);
    expect(tainted).toHaveLength(2);
    expect(tainted[0].advisoryId).toBe('GHSA-1');
    expect(tainted[1].advisoryId).toBe('GHSA-2');
  });
});
