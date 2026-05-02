import fs from 'fs/promises';
import path from 'path';
import { EXCLUDE_DIRS, EXCLUDE_EXTENSIONS } from './constants.js';

export interface FileCandidate {
    path: string;
    score: number;
}

export class WorkspaceWalker {
    /**
     * Recursively find and rank files based on keyword relevance
     */
    static async findRelevantFiles(
        rootPath: string,
        keywords: string[],
        limit: number = 30
    ): Promise<string[]> {
        const candidates: FileCandidate[] = [];
        await this.walk(rootPath, keywords, candidates);

        // Sort by score (descending) and return top paths
        return candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(c => c.path);
    }

    private static async walk(
        dir: string,
        keywords: string[],
        candidates: FileCandidate[]
    ): Promise<void> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (EXCLUDE_DIRS.includes(entry.name)) continue;
                    await this.walk(fullPath, keywords, candidates);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
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
        const codeExtensions = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h'];
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
