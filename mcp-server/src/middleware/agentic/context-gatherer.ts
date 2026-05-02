import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { WorkspaceWalker } from './workspace-walker.js';
import fs from 'fs/promises';

const execAsync = promisify(exec);

export interface ContextGathererOptions {
    workspaceRoot: string;
    query: string;
    limit?: number;
    envType?: 'node' | 'python' | 'general';
}

export class ContextGatherer {
    /**
     * Proactive Grep/RG context gathering.
     * Searches for relevant code snippets and architecture patterns.
     */
    static async gatherContext(options: ContextGathererOptions): Promise<string[]> {
        const { workspaceRoot, query, limit = 5 } = options;

        // 1. Detect Environment
        let envType: 'node' | 'python' | 'general' = options.envType || 'general';
        if (envType === 'general') {
            try {
                const hasPkgJson = await fs.access(path.join(workspaceRoot, 'package.json')).then(() => true).catch(() => false);
                if (hasPkgJson) envType = 'node';
                else {
                    const hasReqs = await fs.access(path.join(workspaceRoot, 'requirements.txt')).then(() => true).catch(() => false);
                    if (hasReqs) envType = 'python';
                }
            } catch { }
        }

        // 2. Keyword Extraction (including code blocks)
        const terms = new Set<string>();
        const codeBlocks = query.match(/```[\s\S]*?```/g) || [];
        codeBlocks.forEach(block => {
            block.split(/\W+/).filter(t => t.length > 5).forEach(t => terms.add(t));
        });

        const broadKeywords = ['architecture', 'review', 'implementation', 'system', 'senior', 'software', 'project'];
        query.split(/\W+/)
            .filter(t => t.length > 4 && !broadKeywords.includes(t.toLowerCase()))
            .forEach(t => terms.add(t));

        const finalTerms = Array.from(terms).slice(0, 5);
        if (finalTerms.length === 0) return [];

        const isTheoretical = /\b(doc|documentation|guide|explain|theory|writeup|summary|overview)\b/i.test(query);

        // 3. Rank Candidates via WorkspaceWalker
        const candidates = await WorkspaceWalker.findRelevantFiles(workspaceRoot, Array.from(terms), 30);
        if (candidates.length === 0) return [];

        const globFlags = candidates.map(c => `-g "${path.relative(workspaceRoot, c)}"`).join(' ');

        // 3. Tool Detection
        let tool: 'rg' | 'grep' | 'none' = 'none';
        try {
            await execAsync('rg --version');
            tool = 'rg';
        } catch {
            try {
                await execAsync('grep --version');
                tool = 'grep';
            } catch {
                return [];
            }
        }

        // 4. Parallelized Search
        const searchTasks = finalTerms.map(async (term): Promise<string[]> => {
            try {
                let command: string;
                if (tool === 'rg') {
                    command = `rg -m 4 ${globFlags} -n --no-heading "${term}" "${workspaceRoot}"`;
                } else {
                    const patterns = isTheoretical
                        ? ['*.md', '*.txt', '*.pdf']
                        : ['*.ts', '*.js', '*.py', '*.rs', '*.go', '*.java', '*.c', '*.cpp', '*.h'];
                    const includeFlags = patterns.map(p => `--include="${p}"`).join(' ');
                    const excludeDirs = envType === 'node'
                        ? ['node_modules', 'dist', '.next']
                        : envType === 'python' ? ['venv', '.venv', '__pycache__'] : [];
                    const excludeFlags = excludeDirs.map(d => `--exclude-dir="${d}"`).join(' ');
                    command = `grep -rEi -m 4 ${includeFlags} ${excludeFlags} "${term}" "${workspaceRoot}" | head -n 4`;
                }

                const { stdout } = await execAsync(command);
                if (stdout) {
                    return stdout.split('\n').filter(Boolean).map(line => `[Context] ${line.trim()}`);
                }
            } catch { }
            return [];
        });

        const nested = await Promise.all(searchTasks);
        return nested.flat();
    }
}
