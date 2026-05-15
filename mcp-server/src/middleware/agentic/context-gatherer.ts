import { spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { WorkspaceWalker } from './workspace-walker.js';
import fs from 'fs/promises';

/**
 * Robust spawn wrapper for cross-platform command execution.
 */
function spawnAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        // Use shell: false to prevent cmd.exe from misinterpreting regex pipes (|) as command pipes
        const child = spawn(command, args, { shell: false });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => stdout += data.toString());
        child.stderr.on('data', data => stderr += data.toString());
        child.on('close', code => {
            // rg and grep return 1 if no matches found, which we handle as success with empty results
            if (code === 0 || code === 1) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`Command failed with code ${code}: ${stderr}`));
            }
        });
        child.on('error', reject);
    });
}

export interface ContextGathererOptions {
    workspaceRoot: string;
    query: string;
    keywords?: string[];
    limit?: number;
    envType?: 'node' | 'python' | 'general';
}

export class ContextGatherer {
    // No longer needed with spawn arguments array

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

        // 2. Keyword Extraction
        const terms = new Set<string>();
        
        // 2.0. Add explicit keywords if provided
        if (options.keywords) {
            options.keywords.forEach(kw => {
                if (kw.length > 2) terms.add(kw);
            });
        }

        // 2a. Extract explicitly quoted terms
        const quotes = query.match(/["']([^"']+)["']/g) || [];
        quotes.forEach(q => {
            const term = q.replace(/["']/g, '').trim();
            if (term.length > 3) terms.add(term);
        });

        // 2b. Extract code blocks
        const codeBlocks = query.match(/```[\s\S]*?```/g) || [];
        codeBlocks.forEach(block => {
            block.split(/\W+/).filter(t => t.length > 5).forEach(t => terms.add(t));
        });

        // 2c. Extract inline code
        const inlineCode = query.match(/`([^`]+)`/g) || [];
        inlineCode.forEach(c => {
            const term = c.replace(/`/g, '').trim();
            term.split(/[\/\\._-]+/).forEach(part => {
                if (part.length >= 5) terms.add(part);
            });
            if (term.length > 3) terms.add(term);
        });

        // 2d. Fallback heuristics
        if (terms.size === 0) {
            const baseBroadKeywords = ['architecture', 'review', 'implementation', 'system', 'senior', 'software', 'project', 'please', 'could', 'would', 'where', 'how', 'what', 'why'];
            
            // Dynamically discover top-level folders as broad/organizational keywords
            let dynamicBroadKeywords: string[] = [];
            try {
                const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
                dynamicBroadKeywords = entries
                    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                    .map(e => e.name.toLowerCase());
            } catch {}

            const projectName = path.basename(workspaceRoot);
            const projectKeywords = projectName.toLowerCase().split(/[-_.\s]+/).filter(k => k.length > 2);
            const broadKeywords = new Set([...baseBroadKeywords, ...projectKeywords, ...dynamicBroadKeywords]);

            query.split(/\W+/)
                .filter(t => t.length > 4 && !broadKeywords.has(t.toLowerCase()))
                .filter(t => /^[a-z]+(?:_[a-z0-9]+)+$|^[a-z]+(?:[A-Z][a-z0-9]+)+$|^[A-Z][a-z0-9]+(?:[a-z0-9]+)?$/.test(t) || t.length > 8)
                .forEach(t => terms.add(t));
        }

        const finalTerms = Array.from(terms).slice(0, 5);
        if (finalTerms.length === 0) return [];

        // 3. Combine terms into a single regex pattern for efficiency
        const combinedPattern = finalTerms.join('|');

        const isTheoretical = /\b(doc|documentation|guide|explain|theory|writeup|summary|overview)\b/i.test(query);
        const overrideIgnores = /\b(override|all files|gitignored|ignored|data)\b/i.test(query);

        // 4. Rank Candidates
        const candidates = await WorkspaceWalker.findRelevantFiles(workspaceRoot, Array.from(terms), limit, overrideIgnores, isTheoretical);
        if (candidates.length === 0) return [];

        // 5. Tool Detection
        let tool: 'rg' | 'grep' | 'none' = 'none';
        try {
            await spawnAsync('rg', ['--version']);
            tool = 'rg';
        } catch {
            try {
                await spawnAsync('grep', ['--version']);
                tool = 'grep';
            } catch {
                return [];
            }
        }

        // 6. Execute Search (Single pass with combined pattern)
        const results: string[] = [];
        try {
            const normalizedCandidates = candidates.map(c => c.replace(/\\/g, '/'));
            let stdout = '';
            
            // We use a total match limit of 10 per file to prevent bloat
            if (tool === 'rg') {
                const args = ['-m', '10', '-n', '-i', '-C', '2', '--no-heading'];
                if (overrideIgnores) args.push('-u');
                args.push('-e', `(${combinedPattern})`);
                args.push(...normalizedCandidates);
                
                const res = await spawnAsync('rg', args);
                stdout = res.stdout;
            } else {
                const args = ['-n', '-E', '-i', '-m', '10', '-C', '2', `(${combinedPattern})`].concat(normalizedCandidates);
                const res = await spawnAsync('grep', args);
                stdout = res.stdout;
            }
            if (stdout) {
                const rawMatches = stdout.split('\n').filter(Boolean);
                
                // 7. Group by File and Deduplicate
                const grouped = new Map<string, Array<{ line: number; content: string }>>();
                const { Sanitizer } = await import('../../utils/Sanitizer.js');

                for (const match of rawMatches) {
                    if (match === '--') continue;
                    try {
                        // Handle formatting: path/to/file:line:content or path/to/file-line-content
                        // Use regex to split reliably even if path contains colons or dashes
                        const parts = match.match(/^(.+?)[:|-](\d+)[:|-](.*)$/);
                        if (parts) {
                            const rawFilePath = parts[1];
                            const lineNum = parseInt(parts[2]);
                            const content = parts[3].trim();

                            if (!isNaN(lineNum) && content) {
                                // Strip workspace root from file path to save tokens
                                let displayPath = rawFilePath;
                                try {
                                    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase();
                                    const normalizedPath = rawFilePath.replace(/\\/g, '/').toLowerCase();
                                    if (normalizedPath.startsWith(normalizedRoot)) {
                                        displayPath = rawFilePath.substring(normalizedRoot.length).replace(/^[\\\/]/, '').replace(/\\/g, '/');
                                    }
                                } catch {}

                                if (!grouped.has(displayPath)) grouped.set(displayPath, []);
                                const lines = grouped.get(displayPath)!;
                                if (!lines.some(l => l.line === lineNum)) {
                                    lines.push({ line: lineNum, content: Sanitizer.sanitize(content) });
                                }
                            }
                        }
                    } catch {}
                }

                // 8. Format final results with Priority Sorting
                const getPriority = (filePath: string): number => {
                    const ext = path.extname(filePath).toLowerCase();
                    const codeExts = ['.ts', '.py', '.js', '.tsx', '.jsx', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.java', '.sh', '.rb', '.php', '.cs', '.swift'];
                    const configExts = ['.json', '.yml', '.yaml', '.toml', '.env', '.xml', '.ini'];
                    if (codeExts.includes(ext)) return 1;
                    if (configExts.includes(ext)) return 2;
                    return 3; // Docs and others
                };

                const sortedFiles = Array.from(grouped.keys()).sort((a, b) => {
                    const prioA = getPriority(a);
                    const prioB = getPriority(b);
                    if (prioA !== prioB) return prioA - prioB;
                    return a.localeCompare(b); // Fallback to alphabetical
                });
                for (const file of sortedFiles) {
                    const lines = grouped.get(file)!.sort((a, b) => a.line - b.line);
                    results.push(`[Context] --- FILE: ${file} ---`);
                    for (const { line, content } of lines) {
                        const displayContent = content.length > 400 ? `${content.slice(0, 400)}... (truncated)` : content;
                        results.push(`L${line}: ${displayContent}`);
                    }
                }
            }
        } catch (e: any) {
            // Handle no matches found error (rg/grep exit code 1)
        }

        return results;
    }
}
