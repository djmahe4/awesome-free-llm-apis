import fs from 'fs/promises';
import path from 'path';
import ignore from 'ignore';
import { 
    EXCLUDE_DIRS, 
    EXCLUDE_EXTENSIONS,
    MAX_DEPTH,
    MAX_FILES_SCANNED
} from './constants.js';

export interface FileCandidate {
    path: string;
    score: number;
}

export class WorkspaceWalker {
    private static filesScanned = 0;

    /**
     * Recursively find and rank files based on keyword relevance
     */
    static async findRelevantFiles(
        rootPath: string,
        keywords: string[],
        limit: number = 30,
        overrideIgnores: boolean = false
    ): Promise<string[]> {
        const candidates: FileCandidate[] = [];
        this.filesScanned = 0;

        const ig = ignore().add(EXCLUDE_DIRS);
        
        if (!overrideIgnores) {
            try {
                const gitignorePath = path.join(rootPath, '.gitignore');
                const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
                ig.add(gitignoreContent);
            } catch {
                // No .gitignore, proceed with defaults
            }
        }

        await this.walk(rootPath, rootPath, keywords, candidates, ig, 0, overrideIgnores);

        // Sort by score (descending) and return top paths
        return candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(c => c.path);
    }

    private static async walk(
        root: string,
        currentDir: string,
        keywords: string[],
        candidates: FileCandidate[],
        ig: any,
        depth: number,
        overrideIgnores: boolean
    ): Promise<void> {
        if (depth > MAX_DEPTH || this.filesScanned >= MAX_FILES_SCANNED) return;

        try {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                if (this.filesScanned >= MAX_FILES_SCANNED) break;

                const fullPath = path.join(currentDir, entry.name);
                const relativePath = path.relative(root, fullPath);

                // Skip if ignored (unless overridden)
                if (!overrideIgnores && ig.ignores(relativePath)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await this.walk(root, fullPath, keywords, candidates, ig, depth + 1, overrideIgnores);
                } else if (entry.isFile()) {
                    this.filesScanned++;
                    const ext = path.extname(entry.name).toLowerCase();
                    
                    // Simple extension filter (still useful to prune binaries quickly)
                    if (EXCLUDE_EXTENSIONS.includes(ext)) continue;

                    const score = this.calculateScore(entry.name, ext, keywords);
                    if (score > 0) {
                        candidates.push({ path: fullPath, score });
                    }
                }
            }
        } catch (error) {
            // Silently ignore errors for inaccessible directories
        }
    }

    private static calculateScore(filename: string, ext: string, keywords: string[]): number {
        let score = 0;
        const nameLower = filename.toLowerCase();

        // 1. Extension boost (prioritize source code)
        const codeExtensions = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.md'];
        if (codeExtensions.includes(ext)) score += 5;

        // 2. Keyword matches in filename
        for (const kw of keywords) {
            const kwLower = kw.toLowerCase();
            if (nameLower.includes(kwLower)) {
                score += 10;
                // Bonus for exact matches (minus extension)
                const nameWithoutExt = path.parse(nameLower).name;
                if (nameWithoutExt === kwLower) score += 20;
            }
        }

        // 3. Structural boost
        if (nameLower.includes('config') || nameLower.includes('setup') || nameLower.includes('index')) {
            score += 3;
        }

        return score;
    }
}
