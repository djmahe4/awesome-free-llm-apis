import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class WorkspaceScanner {
    private hashes: Map<string, { hash: string; lastScan: number }> = new Map();
    private readonly scanThresholdMs = 10000;

    constructor(private defaultProjectRoot: string) { }

    getWorkspaceHash(projectRoot?: string): string {
        const root = projectRoot || this.defaultProjectRoot;
        const cached = this.hashes.get(root);
        const now = Date.now();

        if (cached && now - cached.lastScan < this.scanThresholdMs) {
            return cached.hash;
        }

        const hash = createHash('sha256');
        // Scan src/tools and src/providers in the provided root
        // Also scan the root itself for config files
        this.scanDirectory(join(root, 'src/tools'), hash);
        this.scanDirectory(join(root, 'src/providers'), hash);
        this.scanDirectory(join(root, '.'), hash, 1); // Depth 1 for config files

        const finalHash = hash.digest('hex');
        this.hashes.set(root, { hash: finalHash, lastScan: now });
        return finalHash;
    }

    private scanDirectory(dir: string, hash: ReturnType<typeof createHash>, maxDepth = 10, currentDepth = 0) {
        if (currentDepth > maxDepth) return;
        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    this.scanDirectory(fullPath, hash, maxDepth, currentDepth + 1);
                } else if (entry.isFile() && (
                    entry.name.endsWith('.ts') ||
                    entry.name.endsWith('.js') ||
                    entry.name.endsWith('.json') ||
                    entry.name === '.env'
                )) {
                    const stats = statSync(fullPath);
                    hash.update(`${entry.name}:${stats.size}:${stats.mtimeMs}`);
                }
            }
        } catch {
            // Ignore errors for non-existent directories
        }
    }
}
