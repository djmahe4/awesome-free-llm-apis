import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';
import { CyberToolsRegistry, validateRegistration } from '../src/utils/CyberToolsRegistry.js';
import { cyberTool, clampSliceSize, isValidToolName } from '../src/tools/cyber-tool.js';

describe('validateRegistration', () => {
  const ok = (n: string, u: string, t: any = 'generic', c: any = 'other') => validateRegistration(n, u, t, c);

  it('accepts ordinary registrations', () => {
    expect(ok('my-tool', 'https://github.com/owner/repo', 'github', 'security')).toEqual({ ok: true });
    expect(ok('tool.v2_x+y', 'https://example.com/docs', 'generic')).toEqual({ ok: true });
    expect(ok('img', 'ghcr.io/owner/image:tag', 'docker')).toEqual({ ok: true });
    expect(ok('pkg', 'nmap', 'apt')).toEqual({ ok: true });
  });

  it.each(['', ' ', '__proto__', 'constructor ', '../x', 'a/b', 'a b', '-lead', 'x'.repeat(65), 'tool\nname', 'tab\tname', '\u0000'])('rejects the name %j', name => {
    const r = ok(name, 'https://example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/i);
  });

  it.each(['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.com/x', 'http://', 'a b c', 'https://exa mple.com', 'x'.repeat(3000), 'https://a.com/\u0000'])('rejects the url %j', url => {
    const r = ok('good-name', url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/url/i);
  });

  it('a github registration must really be a github.com owner/repo URL', () => {
    expect(ok('t', 'https://example.com/owner/repo', 'github').ok).toBe(false);
    expect(ok('t', 'https://github.com/owner', 'github').ok).toBe(false);
    expect(ok('t', 'https://evil.com/github.com/owner/repo', 'github').ok).toBe(false);
    expect(ok('t', 'https://github.com/owner/repo', 'github').ok).toBe(true);
  });

  it('rejects an unknown urlType or category', () => {
    expect(ok('t', 'https://example.com', 'weird' as any).ok).toBe(false);
    expect(ok('t', 'https://example.com', 'generic', 'weird' as any).ok).toBe(false);
  });
});

describe('registerTool / register_tool use it and never corrupt the registry', () => {
  it('a rejected registration writes nothing', async () => {
    const before = await fs.readFile(CyberToolsRegistry.getRegistryFilePath(), 'utf-8').catch(() => '');
    await expect(CyberToolsRegistry.registerTool('__proto__', 'https://example.com')).rejects.toThrow(/name/i);
    await expect(CyberToolsRegistry.registerTool('fine', 'javascript:alert(1)')).rejects.toThrow(/url/i);
    const after = await fs.readFile(CyberToolsRegistry.getRegistryFilePath(), 'utf-8').catch(() => '');
    expect(after).toBe(before);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('the action surface reports a clear error', async () => {
    await expect(cyberTool({ action: 'register_tool', toolName: 'bad name', url: 'https://example.com', sessionId: 's' } as any)).rejects.toThrow(/name/i);
    await expect(cyberTool({ action: 'register_tool', toolName: 'ok-name', url: 'file:///etc/passwd', sessionId: 's' } as any)).rejects.toThrow(/url/i);
  });
});

describe('tool names used in wiki paths', () => {
  it('isValidToolName', () => {
    for (const n of ['nmap', 'hexstrike-ai', 'cybersec-toolkit', 'a.b_c+d', 'X1']) expect(isValidToolName(n)).toBe(true);
    for (const n of ['', 'a/b', '../x', 'a b', 'name\nwith-newline', '-x', 'x'.repeat(70), 42 as any, undefined as any]) expect(isValidToolName(n)).toBe(false);
  });

  it('wiki_lookup and tool_memory refuse a hostile tool name instead of building a page path from it', async () => {
    for (const toolName of ['../../etc', 'a\nrisk: x', 'a/b']) {
      await expect(cyberTool({ action: 'wiki_lookup', toolName, sessionId: 's' } as any), toolName).rejects.toThrow(/toolName/i);
      await expect(cyberTool({ action: 'tool_memory', toolName, memoryOp: 'read', sessionId: 's' } as any), toolName).rejects.toThrow(/toolName/i);
    }
  });
});

describe('clampSliceSize (sliceSize 0 used to loop forever, negatives sliced from the end)', () => {
  it('always returns an integer between 1 and 50', () => {
    expect(clampSliceSize(undefined)).toBe(50);
    expect(clampSliceSize(0)).toBe(1);
    expect(clampSliceSize(-5)).toBe(1);
    expect(clampSliceSize(NaN)).toBe(50);
    expect(clampSliceSize(Infinity)).toBe(50);
    expect(clampSliceSize(7.9)).toBe(7);
    expect(clampSliceSize(500)).toBe(50);
    expect(clampSliceSize('12' as any)).toBe(12);
    expect(clampSliceSize('abc' as any)).toBe(50);
  });
});
