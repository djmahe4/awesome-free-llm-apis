import { describe, it, expect, vi } from 'vitest';
import { cyberTool } from '../src/tools/cyber-tool.js';

describe('cyber_tool OSINT action', () => {
  it('throws error when target is missing or whitespace for osint action', async () => {
    await expect(
      cyberTool({ action: 'osint' as any, sessionId: 'test-session' })
    ).rejects.toThrow(/target is required/i);

    await expect(
      cyberTool({ action: 'osint' as any, target: '   ', sessionId: 'test-session' })
    ).rejects.toThrow(/target is required/i);
  });

  it('rejects private IP, loopback, and metadata targets to prevent SSRF', async () => {
    const invalidTargets = [
      'localhost',
      '127.0.0.1',
      '::1',
      '169.254.169.254',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.5'
    ];

    for (const target of invalidTargets) {
      await expect(
        cyberTool({ action: 'osint' as any, target, sessionId: 'test-ssrf-guard' })
      ).rejects.toThrow(/invalid or private target/i);
    }
  });

  it('performs dns recon and dork generation for a valid domain target', async () => {
    const res: any = await cyberTool({
      action: 'osint' as any,
      target: 'example.com',
      sessionId: 'test-osint'
    });

    expect(res).toBeDefined();
    expect(res.success).toBe(true);
    expect(res.target).toBe('example.com');
    expect(Array.isArray(res.resolvedIps)).toBe(true);
    expect(res.dns).toBeDefined();
    expect(Array.isArray(res.recommendedDorks)).toBe(true);
    expect(res.recommendedDorks.length).toBeGreaterThan(0);
    expect(res.summary).toBeDefined();
  });

  it('generates username-specific dorks when osintType is username without triggering DNS', async () => {
    const res: any = await cyberTool({
      action: 'osint' as any,
      target: 'johndoe_researcher',
      osintType: 'username',
      sessionId: 'test-username-osint'
    });

    expect(res.success).toBe(true);
    expect(res.osintType).toBe('username');
    expect(res.recommendedDorks.some((d: string) => d.includes('github.com'))).toBe(true);
    expect(res.dns).toEqual({});
  });

  it('executes automated multi-step search reconnaissance when autoSearch is true', async () => {
    const res: any = await cyberTool({
      action: 'osint' as any,
      target: 'example.com',
      autoSearch: true,
      sessionId: 'test-auto-search-osint'
    });

    expect(res.success).toBe(true);
    expect(res.searchResults).toBeDefined();
    expect(Array.isArray(res.searchResults)).toBe(true);
  });
});
