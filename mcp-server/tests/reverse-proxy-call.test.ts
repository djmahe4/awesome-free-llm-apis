import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReaProxy, ProxyError } from '../src/reverse/proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_REA = path.join(here, '..', 'scripts', 'smoke', 'fixtures', 'fake-rea.mjs');

describe('ReaProxy Tool Execution, Timeouts, Buffering and Caps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-call-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reassembles partial writes split across chunks', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'partial' } as Record<string, string>,
    });
    await proxy.start();
    const result = await proxy.call('inspect_artifact', { path: '/test/path' });
    expect(result.text).toContain('ev-1');
    expect(result.provenance.tool).toBe('inspect_artifact');
    expect(result.provenance.trusted).toBe(false);
    await proxy.close();
  });

  it('times out hung calls and sends cancellation notice to engine', async () => {
    const logPath = path.join(tmpDir, 'hang-log.jsonl');
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'hang', FAKE_REA_LOG: logPath } as Record<string, string>,
      requestTimeoutMs: 1200,
    });
    await proxy.start();

    let errCode = '';
    try {
      await proxy.call('inspect_artifact', {});
    } catch (e: any) {
      errCode = e.code;
    }
    expect(errCode).toBe('timeout');

    const logLines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(logLines.some((m: any) => m.method === 'notifications/cancelled')).toBe(true);

    await proxy.close();
  });

  it('rejects oversize responses, stops engine, and marks proxy closed', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'big' } as Record<string, string>,
      maxResponseBytes: 1024 * 1024,
    });
    await proxy.start();

    let errCode = '';
    try {
      await proxy.call('inspect_artifact', {});
    } catch (e: any) {
      errCode = e.code;
    }
    expect(errCode).toBe('output_too_large');

    let afterCode = '';
    try {
      await proxy.call('inspect_artifact', {});
    } catch (e: any) {
      afterCode = e.code;
    }
    expect(afterCode).toBe('closed');

    await proxy.close();
  });

  it('sanitizes hostile engine output and reports flags', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'hostile' } as Record<string, string>,
    });
    await proxy.start();
    const result = await proxy.call('inspect_artifact', {});

    // Control chars, ANSI, zero-width, and bidi are stripped
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\u2060\ufeff\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(result.text)).toBe(false);
    expect(result.flags).toContain('control_chars');
    expect(result.flags).toContain('zero_width');
    expect(result.flags).toContain('bidi');
    expect(result.flags).toContain('long_base64');
    expect(result.untrustedContent).toBe(true);
    expect(result.provenance.trusted).toBe(false);

    await proxy.close();
  });
it('handles multiple concurrent tool calls safely without cross-talk', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
    });
    await proxy.start();

    const results = await Promise.all([
      proxy.call('inspect_artifact', { path: '/path/1' }),
      proxy.call('analyze_javascript_application', { path: '/path/2' }),
      proxy.call('get_evidence_bundle', { evidence_id: 'ev-1' }),
    ]);

    expect(results).toHaveLength(3);
    for (const res of results) {
      expect(res.text).toContain('ev-1');
      expect(res.untrustedContent).toBe(true);
      expect(res.provenance.trusted).toBe(false);
    }

    await proxy.close();
  });
});
