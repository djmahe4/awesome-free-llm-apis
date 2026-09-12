import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { createExpressApp } from '../src/server.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

describe('GET & POST /api/chat-log/:sessionId & /api/tool tool call visibility', () => {
  const testSessionId = `test-tool-vis-${Date.now()}`;
  const projectsBase = path.join(os.homedir(), '.free-llm-mcp', 'projects');
  const sessionDir = path.join(projectsBase, testSessionId);

  let app: ReturnType<typeof createExpressApp>;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    await fsp.mkdir(sessionDir, { recursive: true });
    app = createExpressApp();
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    server?.close();
    try {
      await fsp.rm(sessionDir, { recursive: true, force: true });
    } catch {}
  });

  it('unwraps payload entries from chat-logs.json so tool_call items have root role, tool, args, result', async () => {
    const rawLogs = [
      {
        sessionId: testSessionId,
        timestamp: 1726000000000,
        type: 'chat',
        payload: {
          role: 'user',
          content: 'Run quantum analysis',
          tool: 'quantum_tool',
          ts: 1726000000000,
        },
      },
      {
        sessionId: testSessionId,
        timestamp: 1726000001000,
        type: 'tool',
        payload: {
          role: 'tool_call',
          tool: 'quantum_tool',
          args: JSON.stringify({ action: 'analyze', query: 'teleportation' }),
          result: JSON.stringify({ success: true, qubits: 4 }),
          latencyMs: 120,
          isError: false,
        },
      },
    ];

    await fsp.writeFile(path.join(sessionDir, 'chat-logs.json'), JSON.stringify(rawLogs, null, 2), 'utf-8');

    const res = await fetch(`${baseUrl}/api/chat-log/${testSessionId}`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.sessionId).toBe(testSessionId);
    expect(Array.isArray(data.log)).toBe(true);
    expect(data.log.length).toBe(2);

    const toolTurn = data.log[1];
    expect(toolTurn.role).toBe('tool_call');
    expect(toolTurn.tool).toBe('quantum_tool');
    expect(toolTurn.latencyMs).toBe(120);
    expect(toolTurn.isError).toBe(false);
    expect(toolTurn.args).toContain('teleportation');
    expect(toolTurn.result).toContain('qubits');
  });

  it('filters tool_call records by query param q matching tool name', async () => {
    const rawLogs = [
      {
        sessionId: testSessionId,
        timestamp: 1726000000000,
        type: 'tool',
        payload: {
          role: 'tool_call',
          tool: 'cyber_tool',
          args: '{}',
          result: '{}',
          latencyMs: 50,
          isError: false,
        },
      },
      {
        sessionId: testSessionId,
        timestamp: 1726000001000,
        type: 'tool',
        payload: {
          role: 'tool_call',
          tool: 'coding_agents',
          args: '{}',
          result: '{}',
          latencyMs: 300,
          isError: false,
        },
      },
    ];

    await fsp.writeFile(path.join(sessionDir, 'chat-logs.json'), JSON.stringify(rawLogs, null, 2), 'utf-8');

    const res = await fetch(`${baseUrl}/api/chat-log/${testSessionId}?q=coding_agents`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.log.length).toBe(1);
    expect(data.log[0].tool).toBe('coding_agents');
  });

  it('logs non-self-logging tool executions to chat-logs.json via /api/tool proxy', async () => {
    const res = await fetch(`${baseUrl}/api/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'get_token_stats',
        params: { sessionId: testSessionId },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const logPath = path.join(sessionDir, 'chat-logs.json');
    expect(await fsp.stat(logPath)).toBeDefined();

    const fetchLogRes = await fetch(`${baseUrl}/api/chat-log/${testSessionId}`);
    const logData = await fetchLogRes.json();

    const toolCallTurn = logData.log.find((t: any) => t.tool === 'get_token_stats');
    expect(toolCallTurn).toBeDefined();
    expect(toolCallTurn.role).toBe('tool_call');
  });
});
