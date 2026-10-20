import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';

export type CyberToolsRegistryCategory = 'security' | 'testing' | 'other';

export type CyberToolsURLType = 'github' | 'apt' | 'docker' | 'generic';

export interface CyberToolsRegistryMap {
    [toolName: string]: { url: string; urlType: CyberToolsURLType; category: CyberToolsRegistryCategory };
}

export class CyberToolsRegistry {
private static DEFAULT_REGISTRY: CyberToolsRegistryMap = {
        sqlmap: { url: 'https://github.com/sqlmapproject/sqlmap', urlType: 'github', category: 'security' },
        nmap: { url: 'https://github.com/nmap/nmap', urlType: 'github', category: 'security' },
        gobuster: { url: 'https://github.com/OJ/gobuster', urlType: 'github', category: 'security' },
        ffuf: { url: 'https://github.com/ffuf/ffuf', urlType: 'github', category: 'security' },
        nikto: { url: 'https://github.com/sulli/nikto', urlType: 'github', category: 'security' },
        hydra: { url: 'https://github.com/vanhauser-thc/thc-hydra', urlType: 'github', category: 'security' }
    };

    /**
     * Gets the target userprofile file path: ~/.free-llm-mcp/cyber-tools-registry.json
     */
    public static getRegistryFilePath(): string {
        // A test run must never resolve (let alone write) the real user-profile
        // registry. tests/setup.ts sandboxes FREE_LLM_MCP_HOME, but a runner that
        // skips it (IDE test panel, root-level `vitest`, another checkout without
        // the sandbox) used to fall through to os.homedir() SILENTLY — that is how
        // ~250 `test-tool-<ts>` entries accumulated in the real file. Fail loudly.
        if (process.env.VITEST && !process.env.FREE_LLM_MCP_HOME) {
            throw new Error(
                'Refusing to resolve the real ~/.free-llm-mcp registry under vitest: FREE_LLM_MCP_HOME is unset, ' +
                'so this test would read/write the user profile. tests/setup.ts sets it — run vitest from mcp-server/ ' +
                'or set FREE_LLM_MCP_HOME to a temp dir.'
            );
        }
        const userHome = process.env.FREE_LLM_MCP_HOME || os.homedir();
        const configDir = path.join(userHome, '.free-llm-mcp');
        return path.join(configDir, 'cyber-tools-registry.json');
    }

    /**
     * True for the `test-tool-<ms-timestamp>` entries the registry test used to leave
     * behind. Requires BOTH the name pattern and (when a url is supplied) the fake
     * `github.com/example/` origin, so a real tool that merely starts with "test-tool"
     * is never classified as debris. Used by the resolver (never suggest these) and
     * by pruneTestDebris.
     */
    public static isTestDebris(name: string, url?: string): boolean {
        if (!/^test-tool-\d+$/i.test(name)) return false;
        if (url === undefined || url === '') return true;
        return /^https?:\/\/github\.com\/example\//i.test(url);
    }

    /**
     * Removes leaked test entries from the registry file. Dry-run by default so the
     * caller sees exactly what would go; a real run writes a timestamped `.bak-*`
     * copy first and swaps the new file in via rename, all under the registry lock.
     */
    public static async pruneTestDebris(opts: { dryRun?: boolean } = {}): Promise<{ removed: string[]; kept: number; backupPath?: string }> {
        const dryRun = opts.dryRun !== false;
        const filePath = this.getRegistryFilePath();
        return await this.withFileLock(filePath, async () => {
            let raw: string;
            try { raw = await fs.readFile(filePath, 'utf-8'); }
            catch (err: any) { if (err.code === 'ENOENT') return { removed: [], kept: 0 }; throw err; }
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const removed: string[] = [];
            const keptEntries: Record<string, unknown> = {};
            for (const [name, value] of Object.entries(parsed)) {
                const url = typeof value === 'string' ? value : (value as { url?: string } | null)?.url;
                if (this.isTestDebris(name, url)) removed.push(name);
                else keptEntries[name] = value;
            }
            const kept = Object.keys(keptEntries).length;
            if (dryRun || removed.length === 0) return { removed, kept };

            const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            await fs.copyFile(filePath, backupPath);
            const tmpPath = `${filePath}.tmp-${process.pid}`;
            await fs.writeFile(tmpPath, JSON.stringify(keptEntries, null, 2), 'utf-8');
            await fs.rename(tmpPath, filePath);
            return { removed, kept, backupPath };
        });
    }

    /**
     * Executes an operation wrapped inside a process-safe file lock (.lock)
     */
    private static async withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
        const lockPath = `${filePath}.lock`;
        const maxRetries = 10;
        const retryDelayMs = 100;

        let acquired = false;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                // wx flag fails if file already exists (atomic lock)
                const handle = await fs.open(lockPath, 'wx');
                await handle.write(process.pid.toString());
                await handle.close();
                acquired = true;
                break;
            } catch (err: any) {
                if (err.code === 'EEXIST') {
                    // Check if lock file is stale (> 5 seconds old)
                    try {
                        const stat = await fs.stat(lockPath);
                        if (Date.now() - stat.mtimeMs > 5000) {
                            await fs.unlink(lockPath);
                        }
                    } catch {}
                    await new Promise(r => setTimeout(r, retryDelayMs));
                } else {
                    break;
                }
            }
        }

        try {
            return await fn();
        } finally {
            if (acquired) {
                try { await fs.unlink(lockPath); } catch {}
            }
        }
    }

    /**
     * Initializes and reads the cyber tools registry from the userprofile directory with file-lock synchronization.
     */
    public static async loadRegistry(): Promise<CyberToolsRegistryMap> {
        const filePath = this.getRegistryFilePath();
        const configDir = path.dirname(filePath);

        return await this.withFileLock(filePath, async () => {
            try {
                await fs.mkdir(configDir, { recursive: true });
                const exists = await fs.stat(filePath).then(() => true).catch(() => false);

                if (!exists) {
                    await fs.writeFile(filePath, JSON.stringify(this.DEFAULT_REGISTRY, null, 2), 'utf-8');
                    return { ...this.DEFAULT_REGISTRY };
                }

                const content = await fs.readFile(filePath, 'utf-8');
                let parsed: CyberToolsRegistryMap = { ...this.DEFAULT_REGISTRY };
                try {
                    const entered = JSON.parse(content);
                    // Merge user entries, supporting both flat ("tool": "url") and nested ("tool": {"url": "...", "urlType": "...", "category": "cat"}) formats
                    for (const [toolName, entry] of Object.entries(entered)) {
                        const lowerName = toolName.toLowerCase();
                        if (typeof entry === 'string') {
                          // Flat format: "tool": "https://...", auto-detect urlType from URL
                          parsed[lowerName] = {
                            url: entry,
                            urlType: this.detectUrlType(entry),
                            category: lowerName in this.DEFAULT_REGISTRY ? 'security' : 'other'
                          };
                        } else {
                          // Nested format: "tool": {"url": "...", "urlType": "...", "category": "cat"}
                          const typedEntry = entry as { url?: string; urlType?: CyberToolsURLType; category?: CyberToolsRegistryCategory };
                          parsed[lowerName] = {
                            url: typedEntry.url || '',
                            urlType: typedEntry.urlType || this.detectUrlType(''),
                            category: typedEntry.category || (lowerName in this.DEFAULT_REGISTRY ? 'security' : 'other')
                          };
                        }
                    }
                } catch {
                    // If parsing fails, fall back to defaults
                }
                return parsed;
            } catch (err) {
                console.warn(`[CyberToolsRegistry] Failed to load registry from ${filePath}, falling back to defaults:`, err);
                return { ...this.DEFAULT_REGISTRY };
            }
        });
    }

    /**
     * Adds or updates a cyber tool URL in the registry using file-lock synchronization.
     */
    public static async registerTool(toolName: string, url: string, urlType: CyberToolsURLType = 'generic', category: CyberToolsRegistryCategory = 'other'): Promise<CyberToolsRegistryMap> {
        const filePath = this.getRegistryFilePath();
        const configDir = path.dirname(filePath);

        return await this.withFileLock(filePath, async () => {
            await fs.mkdir(configDir, { recursive: true });
            let current = { ...this.DEFAULT_REGISTRY };

            try {
                const content = await fs.readFile(filePath, 'utf-8');
                current = { ...current, ...JSON.parse(content) };
            } catch (err: any) {
                if (err.code !== 'ENOENT') {
                    console.error(`[CyberToolsRegistry] Failed to read existing registry at ${filePath}:`, err);
                    throw new Error(`Cannot register tool '${toolName}': existing registry at ${filePath} is unreadable or corrupted (${err.message}). Aborting write to prevent data loss.`);
                }
            }

            const lowerName = toolName.toLowerCase();
            // Do not overwrite default security tools; allow user tools with category
            if (lowerName in this.DEFAULT_REGISTRY) {
                throw new Error(`Cannot overwrite default security tool '${toolName}'. Use a different tool name or register via the user configuration.`);
            }

            current[lowerName] = { url, urlType, category };
            await fs.writeFile(filePath, JSON.stringify(current, null, 2), 'utf-8');
            return current;
        });
    }

/**
     * Gets the GitHub repository URL for a given tool name.
     */
    public static async getToolGithubUrl(toolName: string): Promise<string | undefined> {
        const reg = await this.loadRegistry();
        return reg[toolName.toLowerCase()]?.url;
    }

    /**
     * Detects the URL type from a URL string (github, apt, docker, or generic).
     */
    private static detectUrlType(url: string): CyberToolsURLType {
        if (!url) return 'generic';
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes('github.com')) return 'github';
        // APT repositories - check for common patterns
        const aptDomains = ['packages.', 'apt.', 'deb.', 'archive.'];
        const aptPaths = ['/apt/', '/packages/', '/deb/', '/repo/'];
        for (const domain of aptDomains) {
          if (lowerUrl.includes(domain)) return 'apt';
        }
        for (const path of aptPaths) {
          if (lowerUrl.includes(path)) return 'apt';
        }
        // Docker patterns
        if (lowerUrl.includes('docker') || lowerUrl.includes('dockerhub') || lowerUrl.includes('docker.io')) return 'docker';
        return 'generic';
    }

    /**
     * Gets the categories for all registered cyber tools.
     */
    public static async getToolCategories(): Promise<Record<string, CyberToolsRegistryCategory>> {
        const reg = await this.loadRegistry();
        const result: Record<string, CyberToolsRegistryCategory> = {};
        for (const [toolName, entry] of Object.entries(reg)) {
            result[toolName] = entry.category;
        }
        return result;
    }

    /**
     * Gets the list of all registered cyber tool names.
     */
    public static async getToolNames(): Promise<string[]> {
        const reg = await this.loadRegistry();
        return Object.keys(reg);
    }
}
