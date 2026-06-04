import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DiffScanner } from '../src/middleware/agentic/diff-scanner.js';

describe('DiffScanner Lock-Based Git Integration Tests', () => {
    const testDir = path.join(os.tmpdir(), 'mcp-diff-test-' + Date.now());

    beforeEach(async () => {
        await fs.ensureDir(testDir);
    });

    afterEach(async () => {
        await fs.remove(testDir);
        vi.restoreAllMocks();
    });

    it('isGitRepo() returns false when no .git directory present', async () => {
        const isRepo = await DiffScanner.isGitRepo(testDir);
        expect(isRepo).toBe(false);
    });

    it('isGitRepo() returns true when .git directory is present', async () => {
        await fs.ensureDir(path.join(testDir, '.git'));
        const isRepo = await DiffScanner.isGitRepo(testDir);
        expect(isRepo).toBe(true);
    });

    it('scan() sets hasGit:false for non-git workspace', async () => {
        const result = await DiffScanner.scan(testDir);
        expect(result.hasGit).toBe(false);
    });

    it('acquireLock() returns true when no lock exists', async () => {
        const lockPath = path.join(testDir, 'scan.lock');
        const acquired = await (DiffScanner as any).acquireLock(lockPath, 1000);
        expect(acquired).toBe(true);
        expect(await fs.pathExists(lockPath)).toBe(true);
    });

    it('acquireLock() returns false when fresh lock exists (<5min)', async () => {
        const lockPath = path.join(testDir, 'scan.lock');
        // Create a fresh lock
        await fs.writeFile(lockPath, `${process.pid}:${Date.now()}`);
        const acquired = await (DiffScanner as any).acquireLock(lockPath, 1000);
        expect(acquired).toBe(false);
    });

    it('acquireLock() overwrites stale lock (>5min old)', async () => {
        const lockPath = path.join(testDir, 'scan.lock');
        // Create a stale lock (6 minutes ago)
        await fs.writeFile(lockPath, `${process.pid}:${Date.now() - 6 * 60 * 1000}`);
        const acquired = await (DiffScanner as any).acquireLock(lockPath, 1000);
        expect(acquired).toBe(true);
    });
});
