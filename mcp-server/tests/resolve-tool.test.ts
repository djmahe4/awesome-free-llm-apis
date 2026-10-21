import { describe, it, expect, beforeEach } from 'vitest';
import { matchTools, detectIntent, detectSource, splitMatches } from '../src/utils/ToolResolver.js';
import { resolveTool, resetResolveSessions, type ResolveDeps } from '../src/tools/resolve-tool.js';

const REG = {
  sqlmap: { url: 'https://github.com/sqlmapproject/sqlmap' },
  nmap: { url: 'https://github.com/nmap/nmap' },
  ffuf: { url: 'https://github.com/ffuf/ffuf' },
  hydra: { url: 'https://github.com/vanhauser-thc/thc-hydra' },
  'hexstrike-ai': { url: 'https://github.com/0x4m4/hexstrike-ai' },
  'cybersec-toolkit': { url: 'https://github.com/26zl/cybersec-toolkit' },
  'phishkit-triage': { url: 'https://github.com/trac3r00/phish-triage' },
  'test-tool-123': { url: 'https://github.com/example/test-tool-123' },
};

describe('matchTools', () => {
  it('matches every registry tool by exact name inside prose', () => {
    for (const n of Object.keys(REG).filter(k => !k.startsWith('test-tool'))) {
      expect(matchTools(`please tell me about ${n} dependencies`, REG).map(m => m.name)).toContain(n);
    }
  });
  it('joins words: "hexstrike ai" → hexstrike-ai', () => {
    expect(matchTools('what is hexstrike ai', REG)[0]).toMatchObject({ name: 'hexstrike-ai', kind: 'exact' });
  });
  it('matches via the GitHub repo name alias (phish-triage → phishkit-triage)', () => {
    expect(matchTools('run phish triage on this mail', REG)[0]).toMatchObject({ name: 'phishkit-triage', kind: 'alias' });
    expect(matchTools('thc-hydra options', REG)[0].name).toBe('hydra');
  });
  it('typos are fuzzy suggestions only, and short names never fuzz', () => {
    const f = matchTools('hexstrik-ai help', REG);
    expect(f[0]).toMatchObject({ name: 'hexstrike-ai', kind: 'fuzzy' });
    expect(splitMatches(f).confident).toEqual([]);
    expect(matchTools('nmpa scan', REG)).toEqual([]);
  });
  it('unrelated prompt matches nothing', () => {
    expect(matchTools('how do I bake bread', REG)).toEqual([]);
  });
  it('intent and source detection', () => {
    expect(detectIntent('what libraries does it use')).toBe('dependencies');
    expect(detectIntent('does it ship any skills')).toBe('skills');
    expect(detectIntent('how do I install it')).toBe('install');
    expect(detectSource('on docker hub please')).toBe('docker');
    expect(detectSource('apt package?')).toBe('apt');
    expect(detectSource('hello')).toBeUndefined();
  });
});

const ok = (data: any, url = 'https://x') => ({ found: true as const, data, url });
const miss = (reason: any, detail = 'd', hints?: any) => ({ found: false as const, reason, detail, hints });
const understood = { meta: { fullName: 'o/r', description: 'desc', htmlUrl: 'https://github.com/o/r', defaultBranch: 'main', topics: [], stars: 1, archived: false, fork: false }, treeTruncated: false, fileCount: 1, manifests: [], dependencies: [{ name: 'left', ecosystem: 'npm' as const, source: 'package.json' }], skills: { total: 3, roots: ['.claude/skills'], samples: [] }, mcp: { configFiles: ['.mcp.json'], serverFiles: [] }, usage: { install: [], run: [] }, notes: [] };

function deps(over: Partial<{ gh: any; docker: any; apt: any }> = {}): ResolveDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadRegistry: async () => REG,
    github: { understand: async (o: string, r: string) => { calls.push(`gh:${o}/${r}`); return over.gh ?? ok(understood); } },
    docker: { resolve: async (p: any) => { calls.push(`docker:${p.name}`); return over.docker ?? miss('not_found'); } },
    apt: { resolve: async (p: any) => { calls.push(`apt:${p.name}`); return over.apt ?? miss('not_found'); } },
    packages: { enrich: async () => ({ described: [{ ecosystem: 'npm', name: 'left', latest: '1', url: 'u' }], unresolved: [], skipped: 0 }) },
  } as any;
}
const dockerHit = { best: { fullName: 'a/hex', url: 'u', pullCommand: 'docker pull a/hex', description: '', pulls: 1, stars: 1, isOfficial: false }, evidence: { level: 'strong', reasons: [] }, alternatives: [], unverified: [], checked: [] };

beforeEach(() => resetResolveSessions());

describe('resolveTool', () => {
  it('no matching tool → not_found, and nothing is looked up', async () => {
    const d = deps();
    const r = await resolveTool({ prompt: 'how do I bake bread', sessionId: 's' }, d);
    expect(r).toMatchObject({ success: false, status: 'not_found' });
    expect(d.calls).toEqual([]);
  });

  it('never resolves registry test debris, and an unregistered toolName is not_found', async () => {
    const d = deps();
    expect(await resolveTool({ toolName: 'test-tool-123', sessionId: 's' }, d)).toMatchObject({ status: 'not_found' });
    expect(d.calls).toEqual([]);
  });

  it('dependency question implies GitHub and enriches via package registries', async () => {
    const d = deps();
    const r: any = await resolveTool({ prompt: 'what libraries does cybersec-toolkit depend on', sessionId: 's' }, d);
    expect(r).toMatchObject({ status: 'answer', source: 'github', tool: 'cybersec-toolkit' });
    expect(r.summary.dependencyDescriptions[0].name).toBe('left');
    expect(d.calls).toEqual(['gh:26zl/cybersec-toolkit']);
  });

  it('carries the tool and the chosen source into a pronoun follow-up', async () => {
    const d = deps({ docker: ok(dockerHit) });
    await resolveTool({ prompt: 'hexstrike-ai on docker', sessionId: 's' }, d);
    d.calls.length = 0;
    const r: any = await resolveTool({ prompt: 'and how do I run it?', sessionId: 's' }, d);
    expect(r).toMatchObject({ tool: 'hexstrike-ai', source: 'docker', status: 'answer' });
    expect(d.calls).toEqual(['docker:hexstrike-ai']);
  });

  it('asks which source when several are verified, then honours the reply', async () => {
    const d = deps({ docker: ok(dockerHit) });
    const q: any = await resolveTool({ prompt: 'tell me about hexstrike-ai', sessionId: 's' }, d);
    expect(q).toMatchObject({ status: 'question', options: ['github', 'docker'] });
    const a: any = await resolveTool({ choice: 'docker', sessionId: 's' }, d);
    expect(a).toMatchObject({ status: 'answer', source: 'docker', tool: 'hexstrike-ai' });
  });

  it('a single verified source is used without bothering the user', async () => {
    const d = deps({ gh: miss('not_found') });
    expect(await resolveTool({ prompt: 'tell me about nmap', sessionId: 's' }, deps({ gh: miss('not_found'), docker: ok(dockerHit) }))).toMatchObject({ status: 'answer', source: 'docker' });
    void d;
  });

  it('typo → asks "did you mean", does not guess', async () => {
    const d = deps();
    const r: any = await resolveTool({ prompt: 'hexstrik-ai dependencies', sessionId: 's' }, d);
    expect(r).toMatchObject({ status: 'question', options: ['hexstrike-ai'] });
    expect(d.calls).toEqual([]);
  });

  it('unverified same-name candidates become a question; confirming is labelled user-confirmed', async () => {
    const hints = [{ label: 'oryd/hydra', url: 'u', why: 'name only' }];
    const d = deps({ docker: miss('unverified', 'x', hints) });
    const q: any = await resolveTool({ prompt: 'hydra on docker', sessionId: 's' }, d);
    expect(q).toMatchObject({ status: 'question', source: 'docker', options: ['oryd/hydra'] });
    const a: any = await resolveTool({ choice: 'oryd/hydra', sessionId: 's' }, d);
    expect(a).toMatchObject({ status: 'answer', verified: 'user-confirmed' });
  });

  it('network failure is could_not_verify, never "not found"', async () => {
    const d = deps({ gh: miss('network_error', 'timeout') });
    const r: any = await resolveTool({ prompt: 'nmap dependencies', sessionId: 's' }, d);
    expect(r).toMatchObject({ success: false, status: 'could_not_verify' });
    expect(r.message).toMatch(/not the same as it not existing/);
  });

  it('dead repo link → honest not_found on github', async () => {
    const r: any = await resolveTool({ prompt: 'phishkit-triage skills', sessionId: 's' }, deps({ gh: miss('not_found', 'gone') }));
    expect(r).toMatchObject({ success: false, status: 'not_found', source: 'github' });
  });
});
