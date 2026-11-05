import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReaProxy, ProxyError } from '../src/reverse/proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_REA = path.join(here, '..', 'scripts', 'smoke', 'fixtures', 'fake-rea.mjs');

describe('ReaProxy Handshake & Tool Categorization', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('performs strict handshake in exact order and populates callable/blocked tools', async () => {
    const logPath = path.join(tmpDir, 'handshake-log.jsonl');
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: {
        ...process.env,
        FAKE_REA_LOG: logPath,
      } as Record<string, string>,
    });

    const info = await proxy.start();
    const logLines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const methods = logLines.map((m: any) => m.method);

    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(info.callable.sort()).toEqual(['analyze_javascript_application', 'get_evidence_bundle', 'inspect_artifact']);
    expect(info.blocked.some((b) => b.name === 'write_report')).toBe(true);
    expect(info.blocked.some((b) => b.name === 'rea_setup')).toBe(true);
    expect(proxy.callable.sort()).toEqual(['analyze_javascript_application', 'get_evidence_bundle', 'inspect_artifact']);

    await proxy.close();
  });

  it('blocks tools when schema hash differs from pinned hash', async () => {
    const firstProxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
    });
    const info1 = await firstProxy.start();
    await firstProxy.close();

    const secondProxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: {
        ...process.env,
        FAKE_REA_DESC: 'Tampered description with malicious instructions',
      } as Record<string, string>,
      pins: info1.pins,
    });

    const info2 = await secondProxy.start();
    expect(info2.blocked.some((b) => b.name === 'inspect_artifact' && b.reason === 'schema_changed')).toBe(true);
    expect(info2.callable.includes('inspect_artifact')).toBe(false);
    expect(info2.callable.includes('get_evidence_bundle')).toBe(true);

    await expect(secondProxy.call('inspect_artifact', {})).rejects.toThrow(ProxyError);
    await secondProxy.close();
  });

  it('terminates spawned engine process when handshake fails or times out', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      handshakeTimeoutMs: 300,
    });

    let thrown = false;
    try {
      await proxy.start();
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);

    // Proxy must be closed and cleaned up, not leave orphaned child
    await expect(proxy.call('inspect_artifact', {})).rejects.toThrow(/closed/);
  });
it('handles concurrent calls to start() safely', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
    });
    const [res1, res2] = await Promise.all([
      proxy.start(),
      proxy.start(),
    ]);
    expect(res1.callable).toEqual(res2.callable);
    expect(res1.blocked).toEqual(res2.blocked);
    await proxy.close();
  });
});
