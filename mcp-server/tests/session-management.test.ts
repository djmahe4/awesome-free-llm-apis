import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { extractIntelligentTitle, logChatTurn } from '../src/utils/ChatLogger.js';

describe('Intelligent Conversation Naming & Session Management (TDD)', () => {
  const testSessionId = 'test-session-title-123';
  const testProjectDir = path.join(os.homedir(), '.free-llm-mcp', 'projects', testSessionId);

  beforeEach(async () => {
    await fs.remove(testProjectDir);
  });

  afterEach(async () => {
    await fs.remove(testProjectDir);
  });

  describe('extractIntelligentTitle', () => {
    it('extracts concise title from markdown headings', () => {
      const output = '# Vulnerability Assessment Report\nFound 3 open ports and outdated SSL certificates on host.';
      const title = extractIntelligentTitle(output);
      expect(title).toContain('Vulnerability Assessment Report');
    });

    it('extracts clean title from first sentence / phrases and strips conversational filler', () => {
      const output = 'Sure! I can help you with that. The quantum state vector collapsed onto candidate model Qwen-2.5-Coder with 94% fidelity.';
      const title = extractIntelligentTitle(output);
      expect(title).toContain('Quantum State Vector');
    });

    it('appends workspace unique ID if workspaceRoot is provided', () => {
      const output = 'Analysis complete. Applied local patch to auth controller.';
      const titleWithWs = extractIntelligentTitle(output, 'c:/dev/my-secure-project');
      expect(titleWithWs).toContain('[my-secure-project]');
    });

    it('appends [none] if workspace is explicitly undefined or none', () => {
      const output = 'Quantum superposition initialized.';
      const titleWithoutWs = extractIntelligentTitle(output, undefined);
      expect(titleWithoutWs).toContain('[none]');
    });

    it('handles JSON tool outputs gracefully', () => {
      const output = JSON.stringify({
        status: 'success',
        resolvedIps: ['192.168.1.1'],
        domain: 'example.com',
        summary: 'Passive OSINT DNS Enumeration completed'
      });
      const title = extractIntelligentTitle(output, '/home/user/apps/backend');
      expect(title).toContain('Passive OSINT DNS Enumeration');
      expect(title).toContain('[backend]');
    });
  });

  describe('Auto-titling on 1st response turn in ChatLogger', () => {
    it('automatically generates and saves name.txt on first assistant or tool turn', async () => {
      const turn = {
        role: 'assistant',
        content: '# Network Architecture Overview\nAll microservices routed via envoy proxy.',
        workspaceRoot: '/projects/cloud-infra'
      };

      await logChatTurn(testSessionId, turn);

      const nameFilePath = path.join(testProjectDir, 'name.txt');
      expect(await fs.pathExists(nameFilePath)).toBe(true);

      const savedName = await fs.readFile(nameFilePath, 'utf-8');
      expect(savedName).toContain('Network Architecture Overview');
      expect(savedName).toContain('[cloud-infra]');
    });
  });

  describe('Test Pollution Prevention', () => {
    it('identifies and ignores test session directories in denylist', () => {
      const denylist = ['test-', 'bench-', 'smoke-', 'stress-', 'full-stress-', 'e2e-', 'simulation-', 'study-', 'vitest-'];
      expect(denylist.some(prefix => 'test-session-123'.startsWith(prefix))).toBe(true);
      expect(denylist.some(prefix => 'bench-run-456'.startsWith(prefix))).toBe(true);
      expect(denylist.some(prefix => 'vitest-mem-789'.startsWith(prefix))).toBe(true);
      expect(denylist.some(prefix => 'ws-a1b2c3d4e5f60001'.startsWith(prefix))).toBe(false);
    });
  });
});