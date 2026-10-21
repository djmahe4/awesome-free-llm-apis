import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { getMcpHome, sanitizeSessionId } from '../src/utils/mcp-home.js';
import { logChatTurn } from '../src/utils/ChatLogger.js';

const sandbox = () => process.env.FREE_LLM_MCP_HOME as string;

describe('getMcpHome', () => {
  const saved = process.env.FREE_LLM_MCP_HOME;
  afterEach(() => { process.env.FREE_LLM_MCP_HOME = saved; });

  it('honours FREE_LLM_MCP_HOME', () => {
    process.env.FREE_LLM_MCP_HOME = path.join(os.tmpdir(), 'custom-home');
    expect(getMcpHome()).toBe(path.join(os.tmpdir(), 'custom-home'));
  });

  it('refuses to fall back to the real home directory under vitest', () => {
    delete process.env.FREE_LLM_MCP_HOME;
    expect(() => getMcpHome()).toThrow(/under vitest/);
  });
});

describe('sanitizeSessionId', () => {
  it('keeps ordinary ids', () => {
    expect(sanitizeSessionId('ctf-challenge_1.v2')).toBe('ctf-challenge_1.v2');
  });
  it('neutralises traversal and separators', () => {
    for (const bad of ['../x', '..\\x', 'a/b', '/abs', 'C:\\win', '..', '.', '']) {
      const s = sanitizeSessionId(bad);
      expect(s).toMatch(/^[\w][\w.-]{0,63}$/);
      expect(s).not.toContain('..');
    }
  });
  it('caps length at 64', () => {
    expect(sanitizeSessionId('a'.repeat(500))).toHaveLength(64);
  });
});

describe('logChatTurn location', () => {
  it('writes under FREE_LLM_MCP_HOME, never the real home directory', async () => {
    const id = `home-test-${process.pid}-${Date.now()}`;
    await logChatTurn(id, { role: 'user', content: 'hi' });
    expect(await fs.pathExists(path.join(sandbox(), '.free-llm-mcp', 'projects', id, 'chat-logs.json'))).toBe(true);
    expect(await fs.pathExists(path.join(os.homedir(), '.free-llm-mcp', 'projects', id))).toBe(false);
  });

  it('a traversal sessionId cannot escape the projects directory', async () => {
    const marker = `escape-${process.pid}-${Date.now()}`;
    await logChatTurn(`../../${marker}`, { role: 'user', content: 'x' });
    expect(await fs.pathExists(path.join(sandbox(), marker))).toBe(false);
    expect(await fs.pathExists(path.join(path.dirname(sandbox()), marker))).toBe(false);
  });
});
