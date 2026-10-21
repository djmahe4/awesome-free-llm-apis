import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { CyberToolsRegistry } from '../src/utils/CyberToolsRegistry.js';

// Self-contained on purpose: this file used to write `test-tool-<ts>` entries into the
// REAL ~/.free-llm-mcp/cyber-tools-registry.json whenever it ran without tests/setup.ts
// (IDE runner, root-level vitest, another checkout) — ~250 leaked entries. It now
// guarantees its own sandbox, and getRegistryFilePath() refuses to resolve the real
// home under vitest, so a missing sandbox is a loud failure instead of silent pollution.
let ownSandbox: string | undefined;
if (!process.env.FREE_LLM_MCP_HOME) {
    ownSandbox = mkdtempSync(path.join(os.tmpdir(), 'cyber-registry-test-'));
    process.env.FREE_LLM_MCP_HOME = ownSandbox;
}
afterAll(() => { if (ownSandbox) rmSync(ownSandbox, { recursive: true, force: true }); });

/** Runs fn with FREE_LLM_MCP_HOME pointed at a throwaway dir, restoring the previous value after. */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const previous = process.env.FREE_LLM_MCP_HOME;
    const home = mkdtempSync(path.join(os.tmpdir(), 'cyber-registry-prune-'));
    process.env.FREE_LLM_MCP_HOME = home;
    try { return await fn(home); }
    finally {
        process.env.FREE_LLM_MCP_HOME = previous;
        rmSync(home, { recursive: true, force: true });
    }
}

describe('CyberToolsRegistry (sandboxed path & file-locking)', () => {
    it('resolves the registry under FREE_LLM_MCP_HOME, never the real user profile', () => {
        const registryPath = CyberToolsRegistry.getRegistryFilePath();
        expect(registryPath).toContain(path.join('.free-llm-mcp', 'cyber-tools-registry.json'));
        expect(registryPath.startsWith(path.resolve(process.env.FREE_LLM_MCP_HOME!))).toBe(true);
        expect(registryPath).not.toBe(path.join(os.homedir(), '.free-llm-mcp', 'cyber-tools-registry.json'));
    });

    it('refuses to resolve the real home under vitest when the sandbox env is missing', () => {
        const previous = process.env.FREE_LLM_MCP_HOME;
        delete process.env.FREE_LLM_MCP_HOME;
        try {
            expect(process.env.VITEST).toBeTruthy();
            expect(() => CyberToolsRegistry.getRegistryFilePath()).toThrow(/Refusing to resolve the real/);
        } finally {
            process.env.FREE_LLM_MCP_HOME = previous;
        }
    });

    it('loads default cyber tools and creates the registry file', async () => {
        const toolNames = await CyberToolsRegistry.getToolNames();
        expect(toolNames).toContain('sqlmap');
        expect(toolNames).toContain('nmap');
        expect(toolNames).toContain('ffuf');

        const fileExists = await fs.stat(CyberToolsRegistry.getRegistryFilePath()).then(() => true).catch(() => false);
        expect(fileExists).toBe(true);
    });

    it('registers a new cyber tool dynamically with file-lock synchronization', async () => {
        const customTool = 'test-tool-' + Date.now();
        const customUrl = 'https://github.com/example/' + customTool;

        const updatedRegistry = await CyberToolsRegistry.registerTool(customTool, customUrl);
        const entry = updatedRegistry[customTool];
        expect(entry).toBeDefined();
        expect(entry.url).toBe(customUrl);
        expect(['github', 'generic', 'apt', 'docker']).toContain(entry.urlType);
        expect(entry.category).toBe('other');

        const fetchedUrl = await CyberToolsRegistry.getToolGithubUrl(customTool);
        expect(fetchedUrl).toBe(customUrl);
    });
});

describe('CyberToolsRegistry.isTestDebris', () => {
    it('flags test-tool-<digits> with the fake example origin (or no url)', () => {
        expect(CyberToolsRegistry.isTestDebris('test-tool-1792507252231')).toBe(true);
        expect(CyberToolsRegistry.isTestDebris('test-tool-1792507252231', 'https://github.com/example/test-tool-1792507252231')).toBe(true);
    });

    it('does not flag real tools or lookalikes', () => {
        expect(CyberToolsRegistry.isTestDebris('nmap', 'https://github.com/nmap/nmap')).toBe(false);
        expect(CyberToolsRegistry.isTestDebris('test-tool-notdigits')).toBe(false);
        expect(CyberToolsRegistry.isTestDebris('my-test-tool-123')).toBe(false);
        // right name pattern but a REAL origin -> a user's own tool, must be kept
        expect(CyberToolsRegistry.isTestDebris('test-tool-123', 'https://github.com/acme/test-tool-123')).toBe(false);
    });
});

describe('CyberToolsRegistry.pruneTestDebris', () => {
    const seed = {
        sqlmap: 'https://github.com/sqlmapproject/sqlmap',
        'test-tool-1784805962280': 'https://github.com/example/test-tool-1784805962280', // old flat-format debris
        'test-tool-1792507252231': { url: 'https://github.com/example/test-tool-1792507252231', urlType: 'generic', category: 'other' }, // new nested debris
        'test-tool-777': { url: 'https://github.com/acme/test-tool-777', urlType: 'github', category: 'other' }, // lookalike with a real origin: keep
        subfinder: { url: 'https://github.com/projectdiscovery/subfinder', urlType: 'github', category: 'other' },
    };

    it('dry-run reports the debris but leaves the file byte-identical', async () => {
        await withTempHome(async () => {
            const file = CyberToolsRegistry.getRegistryFilePath();
            await fs.mkdir(path.dirname(file), { recursive: true });
            const original = JSON.stringify(seed, null, 2);
            await fs.writeFile(file, original, 'utf-8');

            const result = await CyberToolsRegistry.pruneTestDebris(); // dryRun defaults to true
            expect(result.removed.sort()).toEqual(['test-tool-1784805962280', 'test-tool-1792507252231']);
            expect(result.kept).toBe(3);
            expect(result.backupPath).toBeUndefined();
            expect(await fs.readFile(file, 'utf-8')).toBe(original);
        });
    });

    it('apply writes a backup of the original, removes only the debris, and is idempotent', async () => {
        await withTempHome(async () => {
            const file = CyberToolsRegistry.getRegistryFilePath();
            await fs.mkdir(path.dirname(file), { recursive: true });
            const original = JSON.stringify(seed, null, 2);
            await fs.writeFile(file, original, 'utf-8');

            const result = await CyberToolsRegistry.pruneTestDebris({ dryRun: false });
            expect(result.removed.sort()).toEqual(['test-tool-1784805962280', 'test-tool-1792507252231']);
            expect(result.backupPath).toBeDefined();
            expect(await fs.readFile(result.backupPath!, 'utf-8')).toBe(original);

            const after = JSON.parse(await fs.readFile(file, 'utf-8'));
            expect(Object.keys(after).sort()).toEqual(['sqlmap', 'subfinder', 'test-tool-777']);
            expect(after.subfinder.url).toBe('https://github.com/projectdiscovery/subfinder'); // untouched

            const again = await CyberToolsRegistry.pruneTestDebris({ dryRun: false });
            expect(again.removed).toEqual([]);
            expect(again.backupPath).toBeUndefined();
        });
    });

    it('returns empty (no throw) when the registry file does not exist', async () => {
        await withTempHome(async () => {
            expect(await CyberToolsRegistry.pruneTestDebris({ dryRun: false })).toEqual({ removed: [], kept: 0 });
        });
    });
});
