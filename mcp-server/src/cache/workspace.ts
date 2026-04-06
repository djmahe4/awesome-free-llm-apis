import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export class WorkspaceScanner {
    private hashes: Map<string, string> = new Map();

    constructor(private defaultProjectRoot: string) { }

    getWorkspaceHash(projectRoot?: string): string {
        const root = resolve(projectRoot || this.defaultProjectRoot);

        if (!existsSync(root)) {
            throw new Error(`Workspace root '${root}' does not exist on disk. Please provide a valid absolute directory path.`);
        }

        const cached = this.hashes.get(root);
        if (cached) {
            return cached;
        }

        // Generate a stable identity hash strictly based on the normalized absolute path.
        // We DO NOT hash file contents because adding a single comment would rotate the hash
        // and cause the agent to lose its long-term memory for this project.
        const hash = createHash('sha256');
        hash.update(root);

        const finalHash = hash.digest('hex');
        this.hashes.set(root, finalHash);
        return finalHash;
    }
}
