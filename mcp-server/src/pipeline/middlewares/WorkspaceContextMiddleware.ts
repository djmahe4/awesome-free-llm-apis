import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';
import { memoryManager } from '../../memory/index.js';
import { WorkspaceScanner } from '../../cache/workspace.js';
import { getIntelligentSystemPrompt } from './prompts.js';
import { ContextGatherer } from './context-gatherer.js';
import { WorkspaceIndexer } from '../../memory/indexer.js';
import { getMessageContent, prependToMessageContent } from '../../utils/MessageUtils.js';

const workspaceScanner = new WorkspaceScanner(process.cwd());

/**
 * Generates a lightweight directory tree up to 2 levels deep to provide structural context.
 */
async function getDirectoryTree(dirPath: string, maxDepth = 2, currentDepth = 0): Promise<string> {
    if (currentDepth > maxDepth) return '';
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        let tree = '';
        const indent = '  '.repeat(currentDepth);
        for (const entry of entries) {
            if (['node_modules', '.git', 'dist', 'build', '.next', 'venv', '__pycache__'].includes(entry.name)) continue;
            tree += `${indent}- ${entry.name}${entry.isDirectory() ? '/' : ''}\n`;
            if (entry.isDirectory()) {
                tree += await getDirectoryTree(path.join(dirPath, entry.name), maxDepth, currentDepth + 1);
            }
        }
        return tree;
    } catch {
        return '';
    }
}

/**
 * WorkspaceContextMiddleware - Handles workspace-aware context injection.
 * 
 * This middleware resolves the workspace hash, searches for relevant memory,
 * gathers grep context, and injects the intelligent system prompt.
 * 
 * It runs regardless of the 'agentic' flag as long as a workspace or session is provided,
 * fulfilling the requirement that memory should be active even for non-agentic requests.
 */
export class WorkspaceContextMiddleware implements Middleware {
    name = 'WorkspaceContextMiddleware';

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        const startMs = Date.now();
        const sessionId = context.sessionId;
        const userMessage = context.request.messages.find(m => m.role === 'user');
        const userContent = userMessage ? (typeof userMessage.content === 'string' ? userMessage.content : JSON.stringify(userMessage.content)) : '';
        const isAgentic = context.request.agentic === true;

        // Dynamic budget calculation based on model capacity
        const { getModelContextLimit } = await import('../../utils/model-tokens.js');
        const model = context.request.model;
        const contextLimit = getModelContextLimit(model);

        let memorySliceCount = 4;
        let memoryCharLimit = 1500;
        let grepCharLimit = 4000;

        if (contextLimit >= 1000000) {
            memorySliceCount = 10;
            memoryCharLimit = 4000;
            grepCharLimit = 15000;
        } else if (contextLimit >= 128000) {
            memorySliceCount = 7;
            memoryCharLimit = 3000;
            grepCharLimit = 10000;
        } else if (contextLimit < 32000) {
            memorySliceCount = 2;
            memoryCharLimit = 800;
            grepCharLimit = 1500;
        }

        // 0. Pre-emptive Memory Update for Agentic Requests
        if (isAgentic && context.workspaceRoot && !(context.request as any).skipIndexing) {
            try {
                console.debug(`[WorkspaceContextMiddleware] Pre-emptive indexing for agentic task in ${context.workspaceRoot}`);
                const indexer = new WorkspaceIndexer(context.workspaceRoot);
                // Run indexer with force=false to respect caches but ensure latest files are present
                await indexer.indexWorkspace(context.workspaceRoot, false);
            } catch (err) {
                console.error(`[WorkspaceContextMiddleware] Pre-emptive indexing failed: ${err}`);
            }
        }

        // 1. Resolve Workspace Hash
        if (context.workspaceRoot && !context.wsHash) {
            try {
                context.wsHash = await workspaceScanner.getWorkspaceHash(context.workspaceRoot);
            } catch (err) {
                console.error(`[WorkspaceContextMiddleware] Failed to derive workspace hash: ${err}`);
            }
        }

        // 2. Gather Grep Context (TF-IDF style) and Directory Structure
        let grepResults: string[] = [];
        let dirTree = '';
        if (context.workspaceRoot && userContent) {
            try {
                dirTree = await getDirectoryTree(context.workspaceRoot);
                const queryKeywords = context.keywords || [];
                grepResults = await ContextGatherer.gatherContext({
                    workspaceRoot: context.workspaceRoot,
                    query: userContent,
                    keywords: queryKeywords,
                    modelId: model
                });
            } catch (err) {
                console.error(`[WorkspaceContextMiddleware] Context gathering failed: ${err}`);
            }
        }

        // 3. Search Vector Memory with Priority Sorting
        let memoryContext: string | undefined;
        const allowMemory = context.isOnePass ? !!context.workspaceRoot : true;

        if (allowMemory) {
            const memoryNamespace = context.wsHash 
                ? context.wsHash 
                : (!context.isOnePass ? context.sessionId : undefined);

            if (memoryNamespace) {
                try {
                    const queryForMemory = userContent + (grepResults.length > 0 ? ' ' + grepResults.join(' ').slice(0, 500) : '');
                    const memoryResults = await memoryManager.search(memoryNamespace, queryForMemory);
                
                if (Array.isArray(memoryResults) && memoryResults.length > 0) {
                    // Priority function consistent with ContextGatherer
                    const getPriority = (filePath?: string): number => {
                        if (!filePath) return 3;
                        const ext = path.extname(filePath).toLowerCase();
                        const codeExts = ['.ts', '.py', '.js', '.tsx', '.jsx', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.java', '.sh', '.rb', '.php', '.cs', '.swift'];
                        const configExts = ['.json', '.yml', '.yaml', '.toml', '.env', '.xml', '.ini'];
                        if (codeExts.includes(ext)) return 1;
                        if (configExts.includes(ext)) return 2;
                        return 3;
                    };

                    // Sort memory results by priority before picking top 5
                    const prioritizedMemory = [...memoryResults].sort((a, b) => {
                        const pathA = (a as any).metadata?.path;
                        const pathB = (b as any).metadata?.path;
                        const prioA = getPriority(pathA);
                        const prioB = getPriority(pathB);
                        if (prioA !== prioB) return prioA - prioB;
                        return 0; // Maintain relevance order within same priority
                    });

                    console.debug(`[WorkspaceContext] Found ${memoryResults.length} memory entries, prioritized code first.`);
                    memoryContext = prioritizedMemory
                        .slice(0, memorySliceCount)
                        .map(m => {
                            const str = typeof m === 'string' ? m : (m as any).content || JSON.stringify(m);
                            return str.length > memoryCharLimit ? `- ${str.slice(0, memoryCharLimit)}... (truncated)` : `- ${str}`;
                        })
                        .join('\n');
                }
            } catch (err) {
                console.error(`[WorkspaceContextMiddleware] Memory lookup failed: ${err}`);
            }
        }
    }

        // 4. Grounding Gate check
        let groundingGate = '';
        if (context.workspaceRoot) {
            const readmePath = path.join(context.workspaceRoot, 'README.md');
            try {
                await fs.access(readmePath);
                groundingGate = `\n\n## 📖 READ-FIRST GATE ACTIVATED\nA README.md or project documentation is detected in the workspace root: ${context.workspaceRoot}.\nYou MUST verify all assertions against the provided context blocks in this prompt before proposing any architecture or implementation. Ground your assertions in local file contents.`;
            } catch {
                if (userContent?.includes('file://')) {
                    groundingGate = `\n\n## 🔍 SOURCE-SPECIFIC GROUNDING\nYou are being asked to interact with specific file URIs. You MUST verify their contents via tools BEFORE asserting their structure or state.`;
                }
            }
        }

        // 5. Store context for downstream middlewares (e.g., AgenticMiddleware)
        // Always store memory and grounding gate on context so AgenticMiddleware can consume them.
        (context as any).memoryContext = memoryContext;
        (context as any).groundingGate = groundingGate;
        
        let workspaceContextStr = '';
        if (dirTree) workspaceContextStr += `\nProject Structure:\n${dirTree}\n`;
        if (grepResults.length > 0) {
            // Priority-aware truncation: grepResults is already sorted (Code -> Config -> Docs).
            // We accumulate until grepCharLimit chars to ensure code context is preserved over others.
            let currentLen = 0;
            const prioritizedSnippets: string[] = [];
            for (const snippet of grepResults) {
                if (currentLen + snippet.length > grepCharLimit) {
                    prioritizedSnippets.push(`\n... (context truncated to ${Math.round(grepCharLimit / 1000)}k chars, prioritizing code)`);
                    break;
                }
                prioritizedSnippets.push(snippet);
                currentLen += snippet.length + 1; // +1 for newline
            }
            workspaceContextStr += `\nRelevant File Snippets:\n${prioritizedSnippets.join('\n')}\n`;
        }
        (context as any).grepContext = workspaceContextStr || undefined;

        // Only inject a system prompt when NOT in agentic mode.
        // In agentic mode, AgenticMiddleware owns the system prompt to prevent
        // double-injection which garbles model responses.
        if (!isAgentic) {
            try {
                const isSubtask = (context as any).isSubtask === true;
                const dynamicPrompt = await getIntelligentSystemPrompt({
                    context: userContent,
                    keywords: context.keywords || [],
                    memory: memoryContext,
                    workspace: (context as any).grepContext,
                    isSubtask: isSubtask
                });

                const highLevelStepsSection = `\n\n## HIGH-LEVEL STEPS\nWhen responding to a task, always begin with a numbered list of at most **2** high-level steps.`;

                const CONTEXT_START_MARKER = '<!-- WORKSPACE_CONTEXT_START -->';
                const CONTEXT_END_MARKER = '<!-- WORKSPACE_CONTEXT_END -->';
                const fullSystemPrompt = `\n${CONTEXT_START_MARKER}\n${dynamicPrompt}${highLevelStepsSection}${groundingGate}\n${CONTEXT_END_MARKER}\n`;
                
                const messages = context.request.messages;
                const sysMsgIdx = messages.findIndex(m => m.role === 'system');

                if (sysMsgIdx !== -1) {
                    const msg = messages[sysMsgIdx];
                    const currentContent = getMessageContent(msg.content);
                    if (currentContent.includes(CONTEXT_START_MARKER)) {
                        // Replace existing context block
                        const regex = new RegExp(`${CONTEXT_START_MARKER}[\\s\\S]*?${CONTEXT_END_MARKER}`, 'g');
                        if (typeof msg.content === 'string') {
                            msg.content = msg.content.replace(regex, fullSystemPrompt);
                        } else if (Array.isArray(msg.content)) {
                            msg.content.forEach((p: any) => {
                                if (p.text) p.text = p.text.replace(regex, fullSystemPrompt);
                            });
                        }
                    } else {
                        // Prepend to existing system message
                        prependToMessageContent(msg, fullSystemPrompt + '\n');
                    }
                } else {
                    messages.unshift({ role: 'system', content: fullSystemPrompt });
                }
            } catch (err) {
                console.error(`[WorkspaceContextMiddleware] Prompt injection failed: ${err}`);
            }
        } else {
            console.error(`[WorkspaceContextMiddleware] Agentic mode: skipping own system prompt injection, delegating to AgenticMiddleware.`);
        }

        console.error(`[WorkspaceContextMiddleware] ${Date.now() - startMs}ms context injected for session=${sessionId}`);
        
        await next();
    }
}
