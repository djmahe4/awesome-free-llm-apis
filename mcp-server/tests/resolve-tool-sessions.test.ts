import { describe, it, expect, beforeEach } from 'vitest';
import { resolveTool, resetResolveSessions, resolveSessionIds, type ResolveDeps } from '../src/tools/resolve-tool.js';

// C10: the "LRU" evicted in insertion order (touching a session did not refresh it), and every caller that
// passed no sessionId shared one state, so one caller's pending question was answered by another.

const REG = {
  nmap: { url: 'https://github.com/nmap/nmap' },
  ffuf: { url: 'https://github.com/ffuf/ffuf' },
};
const nf = async () => ({ found: false, reason: 'not_found', detail: 'stub' });
const deps = { loadRegistry: async () => REG, github: { understand: nf }, docker: { resolve: nf }, apt: { resolve: nf }, packages: { enrich: async (x: unknown) => x } } as unknown as ResolveDeps;

beforeEach(() => resetResolveSessions());

describe('session eviction is least-recently-used', () => {
  it('a session that was used again survives while the oldest untouched one is evicted', async () => {
    for (let i = 0; i < 200; i++) await resolveTool({ prompt: 'how do I bake bread', sessionId: `s${i}` }, deps);
    expect(resolveSessionIds()).toHaveLength(200);
    await resolveTool({ prompt: 'how do I bake bread', sessionId: 's0' }, deps); // s0 is now the most recent
    await resolveTool({ prompt: 'how do I bake bread', sessionId: 's200' }, deps); // forces one eviction
    const ids = resolveSessionIds();
    expect(ids).toContain('s0');
    expect(ids).not.toContain('s1');
    expect(ids).toContain('s200');
    expect(ids).toHaveLength(200);
  }, 60000);
});

describe('callers without a sessionId do not share state', () => {
  it('a follow-up question gets its own session id back, and another anonymous caller cannot answer it', async () => {
    const q: any = await resolveTool({ prompt: 'compare nmap and ffuf for me' }, deps);
    expect(q.status).toBe('question');
    expect(typeof q.sessionId).toBe('string');
    expect(q.sessionId.length).toBeGreaterThan(6);

    // a different caller, also without a sessionId, answering "nmap" must not continue the first caller's question
    const stranger: any = await resolveTool({ choice: 'nmap' }, deps);
    expect(stranger.status).not.toBe('question');
    expect(stranger.sessionId).not.toBe(q.sessionId);

    // the first caller continues with the id it was given
    const follow: any = await resolveTool({ choice: 'nmap', sessionId: q.sessionId }, deps);
    expect(follow.status).not.toBe('question');
  });

  it('an anonymous call that needs no follow-up leaves no session behind', async () => {
    await resolveTool({ prompt: 'how do I bake bread' }, deps);
    expect(resolveSessionIds()).toEqual([]);
  });

  it('an explicit sessionId still carries state across calls', async () => {
    const q: any = await resolveTool({ prompt: 'compare nmap and ffuf for me', sessionId: 'mine' }, deps);
    expect(q.status).toBe('question');
    expect(q.sessionId).toBe('mine');
    expect(resolveSessionIds()).toContain('mine');
  });
});
