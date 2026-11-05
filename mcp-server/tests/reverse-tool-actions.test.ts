import { describe, it, expect } from 'vitest';
import { reverseTool, type ReverseToolInput } from '../src/tools/reverse-tool.js';

describe('reverseTool MCP handler', () => {
  it('handles action status and reports node compatibility', async () => {
    const res = await reverseTool({ action: 'status' });
    expect(res.success).toBe(true);
    expect(res.action).toBe('status');
    expect(res.data.nodeVersion).toBeDefined();
    expect(typeof res.data.supportedNode).toBe('boolean');
    expect(res.data.engineStatus).toBeDefined();
  });

  it('rejects unsupported actions', async () => {
    const res = await reverseTool({ action: 'unknown_action' as any });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unsupported action');
  });

  it('enforces authorization for list_capabilities when target is specified', async () => {
    const res = await reverseTool({ action: 'list_capabilities', target: 'sample.exe' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('authorization');
  });

  it('allows list_capabilities when target has valid authorization framing', async () => {
    const res = await reverseTool({
      action: 'list_capabilities',
      target: 'sample.exe',
      authorization: 'ctf',
    });
    expect(res.success).toBe(true);
    expect(res.action).toBe('list_capabilities');
    expect(Array.isArray(res.data.capabilities)).toBe(true);
  });

  it('returns built-in static capabilities for list_capabilities without target', async () => {
    const res = await reverseTool({ action: 'list_capabilities' });
    expect(res.success).toBe(true);
    expect(res.data.capabilities).toContain('analyze_javascript');
    expect(res.data.capabilities).toContain('scan_github');
    expect(res.data.capabilities).toContain('inspect_gguf');
  });

  it('handles engine initialization failure gracefully and cleans up proxy in finally', async () => {
    const origEnv = process.env.REA_AGENTS_PATH;
    try {
      process.env.REA_AGENTS_PATH = 'non_existent_engine_executable_123';
      const res = await reverseTool({ action: 'list_capabilities' });
      expect(res.success).toBe(true);
      expect(res.data.engineBlocked.some((b: any) => b.name === 'rea-engine')).toBe(true);
    } finally {
      process.env.REA_AGENTS_PATH = origEnv;
    }
  });
});
