import path from 'path';
import { promises as fs } from 'fs';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';
import { memoryManager } from '../../memory/index.js';
import { WorkspaceScanner } from '../../cache/workspace.js';
import { getIntelligentSystemPrompt } from '../../middleware/agentic/prompts.js';
import { ContextGatherer } from '../../middleware/agentic/context-gatherer.js';
import { WorkspaceIndexer } from '../../memory/indexer.js';

const workspaceScanner = new WorkspaceScanner(process.cwd());

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

        // 0. Pre-emptive Memory Update for Agentic Requests
        if (isAgentic && context.workspaceRoot) {
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

        // 2. Gather Grep Context (TF-IDF style)
        let grepResults: string[] = [];
        if (context.workspaceRoot && userContent) {
            try {
                grepResults = await ContextGatherer.gatherContext({
                    workspaceRoot: context.workspaceRoot,
                    query: userContent
                });
            } catch (err) {
                console.error(`[WorkspaceContextMiddleware] Grep context failed: ${err}`);
            }
        }

        // 3. Search Vector Memory
        let memoryContext: string | undefined;
        if (context.wsHash) {
            try {
                const queryForMemory = userContent + (grepResults.length > 0 ? ' ' + grepResults.join(' ').slice(0, 500) : '');
                const memoryResults = await memoryManager.search(context.wsHash, queryForMemory);
                if (Array.isArray(memoryResults) && memoryResults.length > 0) {
                    console.debug(`[WorkspaceContext] Found ${memoryResults.length} memory entries for query: "${queryForMemory.slice(0, 50)}..."`);
                    memoryContext = memoryResults
                        .slice(0, 5)
                        .map(m => `- ${typeof m === 'string' ? m : JSON.stringify(m)}`)
                        .join('\n');
                } else {
                    console.debug(`[WorkspaceContext] No memory entries found for query: "${queryForMemory.slice(0, 50)}..."`);
                }
            } catch (err) {
                console.error(`[WorkspaceContextMiddleware] Memory lookup failed: ${err}`);
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
                    isSubtask: isSubtask
                });

                const highLevelStepsSection = `\n\n## HIGH-LEVEL STEPS\nWhen responding to a task, always begin with a numbered list of at most **4** high-level steps.`;

                const fullSystemPrompt = `${dynamicPrompt}${highLevelStepsSection}${groundingGate}`;
                const messages = context.request.messages;
                const hasSystem = messages[0]?.role === 'system';

                if (hasSystem) {
                    messages[0].content = `${fullSystemPrompt}\n\n${messages[0].content}`;
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
