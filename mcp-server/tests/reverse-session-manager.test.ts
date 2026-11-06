import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReaSessionManager } from '../src/reverse/session-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_REA = path.join(here, '..', 'scripts', 'smoke', 'fixtures', 'fake-rea.mjs');

describe('ReaSessionManager Lifecycle', () => {
  let manager: ReaSessionManager;

  beforeEach(() => {
    manager = new ReaSessionManager({
      idleTimeoutMs: 2000,
      command: process.execPath,
      args: [FAKE_REA],
    });
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  it('creates and caches session per target key', async () => {
    const proxy1 = await manager.getOrCreateSession('target-a');
    const proxy2 = await manager.getOrCreateSession('target-a');
    expect(proxy1).toBe(proxy2);
    expect(proxy1.callable).toContain('inspect_artifact');
  });

  it('creates distinct sessions for different targets', async () => {
    const proxyA = await manager.getOrCreateSession('target-a');
    const proxyB = await manager.getOrCreateSession('target-b');
    expect(proxyA).not.toBe(proxyB);
  });

  it('closes specific session cleanly', async () => {
    const proxyA = await manager.getOrCreateSession('target-a');
    expect(manager.hasSession('target-a')).toBe(true);
    await manager.closeSession('target-a');
    expect(manager.hasSession('target-a')).toBe(false);
  });

  it('closes all sessions cleanly on shutdown', async () => {
    await manager.getOrCreateSession('target-1');
    await manager.getOrCreateSession('target-2');
    expect(manager.size).toBe(2);
    await manager.closeAll();
    expect(manager.size).toBe(0);
  });

  it('evicts idle session after idleTimeoutMs expires', async () => {
    const quickManager = new ReaSessionManager({
      idleTimeoutMs: 50,
      command: process.execPath,
      args: [FAKE_REA],
    });
    try {
      await quickManager.getOrCreateSession('target-idle');
      expect(quickManager.hasSession('target-idle')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(quickManager.hasSession('target-idle')).toBe(false);
      expect(quickManager.size).toBe(0);
    } finally {
      await quickManager.closeAll();
    }
  });
});
