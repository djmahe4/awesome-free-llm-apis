import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';

export type CyberToolsRegistryCategory = 'security' | 'testing' | 'other';

export type CyberToolsURLType = 'github' | 'apt' | 'docker' | 'generic';

export const REGISTRY_CATEGORIES: readonly CyberToolsRegistryCategory[] = ['security', 'testing', 'other'];
export const REGISTRY_URL_TYPES: readonly CyberToolsURLType[] = ['github', 'apt', 'docker', 'generic'];

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const GITHUB_REPO_RE = /^https:\/\/(www\.)?github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?\/?([#?].*)?$/;
/** apt package / docker image reference without a scheme, e.g. `nmap` or `ghcr.io/owner/image:tag`. */
const BARE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/;

export type RegistrationCheck = { ok: true } | { ok: false; error: string };

/**
 * A registration comes from a tool call and is stored in a JSON file other tools read, so every field is
 * checked: the name becomes a registry key and wiki page name; the URL is later fetched or shown, so only
 * http(s) URLs (or a bare apt/docker reference) are accepted, never javascript:, file:, data: and so on.
 */
export function validateRegistration(name: unknown, url: unknown, urlType: unknown, category: unknown): RegistrationCheck {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
        return { ok: false, error: 'Invalid tool name: use 1-64 letters, digits, . _ + - and start with a letter or digit.' };
    }
    if (typeof urlType !== 'string' || !(REGISTRY_URL_TYPES as readonly string[]).includes(urlType)) {
        return { ok: false, error: `Invalid urlType: expected one of ${REGISTRY_URL_TYPES.join(', ')}.` };
    }
    if (typeof category !== 'string' || !(REGISTRY_CATEGORIES as readonly string[]).includes(category)) {
        return { ok: false, error: `Invalid category: expected one of ${REGISTRY_CATEGORIES.join(', ')}.` };
    }
    if (typeof url !== 'string' || url.length === 0 || url.length > 2048 || /[\s\u0000-\u001f]/.test(url)) {
        return { ok: false, error: 'Invalid url: expected a non-empty URL up to 2048 characters with no spaces or control characters.' };
    }
    if (/^https?:\/\//i.test(url)) {
        try {
            if (!new URL(url).hostname) throw new Error('no host');
        } catch {
            return { ok: false, error: 'Invalid url: not a valid http(s) URL.' };
        }
    } else if (/^(javascript|file|data|ftp|vbscript|blob|chrome|about):/i.test(url)) {
        return { ok: false, error: 'Invalid url: that scheme is not allowed.' };
    } else if (!BARE_REF_RE.test(url)) {
        return { ok: false, error: 'Invalid url: not an http(s) URL or a bare package/image reference.' };
    }
    if (urlType === 'github' && !GITHUB_REPO_RE.test(url)) {
        return { ok: false, error: 'Invalid url: a github registration must be https://github.com/<owner>/<repo>.' };
    }
    return { ok: true };
}

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
    private static async withFileLock<T>(filePath: string, fn: () => Promise<T>, opts: { required?: boolean } = {}): Promise<T> {
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

        // A reader may proceed without the lock (it only reads), but a WRITER running unlocked can lose another
        // writer's update, so it fails loudly instead.
        if (!acquired && opts.required) {
            throw new Error(`Could not acquire the registry lock (${lockPath}) after ${maxRetries} attempts; another process may be writing. Try again.`);
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
        const check = validateRegistration(toolName, url, urlType, category);
        if (!check.ok) throw new Error(check.error);
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
            // temp file + rename: a crash mid-write leaves the old registry, never a truncated one
            const tmpPath = `${filePath}.tmp-${process.pid}`;
            await fs.writeFile(tmpPath, JSON.stringify(current, null, 2), 'utf-8');
            await fs.rename(tmpPath, filePath);
            return current;
        }, { required: true });
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
