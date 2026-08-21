import { describe, it, expect } from 'vitest';
import { cyberTool } from '../src/tools/cyber-tool.js';

describe('cyber_tool OSINT action', () => {
  it('throws error when target is missing for osint action', async () => {
    await expect(
      cyberTool({ action: 'osint' as any, sessionId: 'test-session' })
    ).rejects.toThrow(/target is required/i);
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
  });
});
