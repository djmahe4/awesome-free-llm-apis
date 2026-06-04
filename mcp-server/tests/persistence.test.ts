import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersistenceManager, PersistentUsage } from '../src/utils/PersistenceManager.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { encrypt, decrypt } from '../src/utils/encryption.js';

describe('Persistence Layer Hardening', () => {
    const testDir = path.join(os.tmpdir(), 'mcp-persistence-test-' + Date.now());
    const testFile = path.join(testDir, 'usage.json');

    beforeEach(async () => {
        await fs.ensureDir(testDir);
        vi.stubEnv('MCP_SECRET_KEY', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    });

    afterEach(async () => {
        await fs.remove(testDir);
        vi.unstubAllEnvs();
    });

    it('should initialize with empty state if file missing', async () => {
        const pm = new PersistenceManager(testFile);
        const state = await pm.load();
        
        expect(state.dailyTotalRequests).toBe(0);
        expect(state.lifetimeTotalRequests).toBe(0);
        expect(state.providers).toEqual({});
    });

    it('should perform atomic Read-Merge-Write (JSON Update Test)', async () => {
        const pm = new PersistenceManager(testFile);
        
        // 1. Initial save
        const initialState: PersistentUsage = {
            lastResetDate: new Date().toISOString().split('T')[0],
            dailyTotalRequests: 1,
            dailyTotalTokens: 100,
            lifetimeTotalRequests: 1,
            lifetimeTotalTokens: 100,
            providers: {
                'p1': { lastSyncTime: Date.now(), localTotalRequests: 1, localTotalTokens: 100 }
            }
        };
        await pm.save(initialState);

        // 2. Simulate concurrent update on disk
        const rawContent = await fs.readFile(testFile, 'utf8');
        const decryptedContent = await decrypt(rawContent);
        const diskState = JSON.parse(decryptedContent);
        diskState.dailyTotalRequests = 10; // Modified by "another process"
        diskState.providers = diskState.providers || {};
        diskState.providers['p2'] = { lastSyncTime: Date.now(), localTotalRequests: 5, localTotalTokens: 500 };
        
        const encryptedDisk = await encrypt(JSON.stringify(diskState));
        await fs.writeFile(testFile, encryptedDisk, 'utf8');

        // 3. Current process saves its state (which only knows about p1)
        const memoryState: PersistentUsage = {
            ...initialState,
            dailyTotalRequests: 2, // Incremented in memory
            providers: {
                'p1': { lastSyncTime: Date.now() + 100, localTotalRequests: 2, localTotalTokens: 200 }
            }
        };
        await pm.save(memoryState);

        // 4. Verify Merge logic
        const finalRaw = await fs.readFile(testFile, 'utf8');
        const finalDecrypted = await decrypt(finalRaw);
        const finalState = JSON.parse(finalDecrypted);
        
        // Global daily counts should be additive (atomic RMW merge using deltas)
        expect(finalState.dailyTotalRequests).toBe(11); // base(10) + delta(1) = 11
        
        // p1 should be updated (latest sync wins)
        expect(finalState.providers['p1'].localTotalRequests).toBe(2);
        
        // p2 should be preserved (merged from disk)
        expect(finalState.providers['p2']).toBeDefined();
        expect(finalState.providers['p2'].localTotalRequests).toBe(5);
    });

    it('should handle daily reset on loading stale data', async () => {
        const pm = new PersistenceManager(testFile);
        
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        const staleData: PersistentUsage = {
            lastResetDate: yesterdayStr,
            dailyTotalRequests: 500,
            dailyTotalTokens: 50000,
            lifetimeTotalRequests: 1000,
            lifetimeTotalTokens: 100000,
            providers: {}
        };
        const encryptedStale = await encrypt(JSON.stringify(staleData));
        await fs.writeFile(testFile, encryptedStale, 'utf8');

        const loaded = await pm.load();
        
        expect(loaded.lastResetDate).toBe(new Date().toISOString().split('T')[0]);
        expect(loaded.dailyTotalRequests).toBe(0); // Reset
        expect(loaded.lifetimeTotalRequests).toBe(1000); // Preserved
    });
});
