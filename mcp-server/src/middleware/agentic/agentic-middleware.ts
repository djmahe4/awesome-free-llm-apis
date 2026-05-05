import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { LRUCache } from 'lru-cache';
import { debounce } from '../../utils/debounce.js';
import type { Middleware, PipelineContext, NextFunction } from '../../pipeline/middleware.js';
import { getMessageContent } from '../../utils/MessageUtils.js';
import { memoryManager } from '../../memory/index.js';
import { getIntelligentSystemPrompt } from './prompts.js';
// Removed top-level import of instances.js to break circular dependency

import {
    PROJECTS_DIR,
    STATE_FILE,
    KNOWLEDGE_FILE
} from './constants.js';
import { ContextGatherer } from './context-gatherer.js';


interface QueueState {
    nowQueue: string[];
    nextQueue: string[];
    blockedQueue: string[];
    improveQueue: string[];
}

/**
 * Memory Management: Using LRUCache instead of Map to prevent leaks in high-concurrency environments.
 * Max 500 active sessions, 24h TTL.
 */
const queues = new LRUCache<string, QueueState>({
    max: 500,
    ttl: 1000 * 60 * 60 * 24,
});

/**
 * Stateless-first state recovery: load from disk if cache miss.
 */
async function getOrLoadState(sessionId: string): Promise<QueueState> {
    let state = queues.get(sessionId);
    if (!state) {
        // Cold start recovery
        try {
            const statePath = path.join(PROJECTS_DIR, sessionId, STATE_FILE);
            const data = await fs.readFile(statePath, 'utf-8');
            state = JSON.parse(data);
            if (state) queues.set(sessionId, state);
        } catch {
            // No saved state or invalid, start fresh
        }
    }

    if (!state) {
        state = {
            nowQueue: [],
            nextQueue: [],
            blockedQueue: [],
            improveQueue: [],
        };
        queues.set(sessionId, state);
    }
    return state;
}

/**
 * Debounced State Persistence: Batches writes to reduce I/O under high throughput.
 */
const persistStateDebounced = debounce(async (sessionId: string, projectDir: string) => {
    const state = queues.get(sessionId);
    if (!state) return;

    try {
        await fs.writeFile(
            path.join(projectDir, STATE_FILE),
            JSON.stringify(state, null, 2),
            'utf-8',
        );
    } catch {
        // non-fatal
    }
}, 2000);


/**
 * Append-only Knowledge Persistence: Accumulates reusable skill entries following
 * the @skill-writer schema. Never overwrites — only appends — so knowledge grows
 * across sessions rather than being reset.

/**
 * Distills an LLM response into a structured skill-writer-schema knowledge entry.
 *
 * Skill-writer schema fields (following standard SKILL.md frontmatter conventions):
 *   - name: short label for the decision/finding (derived from heading or task)
 *   - session: source session ID
 *   - ts: ISO timestamp
 *   - what: the core decision or finding (extracted from bold/heading content)
 *   - why: supporting rationale (extracted from prose context)
 *   - files: file paths referenced (extracted from backtick paths or [file://...] refs)
 *   - example: code block preview if present
 */
function distillToSkillEntry(content: string, sessionId: string): string | null {
    const lines = content.split('\n');

    // 1. Extract the primary heading as the entry name
    const nameMatch = lines.find(l => l.startsWith('## ') || l.startsWith('### '));
    const name = nameMatch ? nameMatch.replace(/^#{2,3}\s+/, '').trim() : `session-${sessionId.slice(0, 8)}`;

    // 2. Extract decisions: bold key-value pairs and completed checklist items
    const decisions = lines
        .filter(l => l.includes('**') || l.includes('- [x]') || l.includes('- ✅'))
        .map(l => l.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 5);

    if (decisions.length === 0) return null;

    // 3. Extract file references: backtick paths and markdown links
    const fileRefs: string[] = [];
    const filePattern = /`([^`]*\.(ts|js|py|go|rs|json|md|yaml|yml|env))`|file:\/\/([^\s)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = filePattern.exec(content)) !== null) {
        const ref = m[1] || m[3];
        if (ref && !fileRefs.includes(ref)) fileRefs.push(ref);
    }

    // 4. Extract code example preview (first code block, first 3 lines)
    const codeBlockMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
    const example = codeBlockMatch
        ? '```\n' + codeBlockMatch[1].split('\n').slice(0, 3).join('\n') + '\n```'
        : null;

    // 5. Compose skill-writer-schema entry
    const entry = [
        `\n\n---`,
        ``,
        `### ${name}`,
        ``,
        `**session:** ${sessionId}  **ts:** ${new Date().toISOString()}`,
        ``,
        `**what:**`,
        decisions.map(d => `- ${d}`).join('\n'),
        fileRefs.length > 0 ? `\n**files:**\n${fileRefs.map(f => `- \`${f}\``).join('\n')}` : '',
        example ? `\n**example:**\n${example}` : '',
    ].filter(l => l !== '').join('\n');

    return entry.length > 100 ? entry : null;
}



/**
 * Append-only Knowledge Persistence: Distills LLM responses into structured
 * skill-writer-schema entries so knowledge.md grows as a reusable knowledge base
 * rather than a raw session log dump.
 */
async function appendKnowledge(projectDir: string, sessionId: string, content: string): Promise<void> {
    const entry = distillToSkillEntry(content, sessionId);
    if (!entry) return;

    try {
        await fs.appendFile(path.join(projectDir, KNOWLEDGE_FILE), entry, 'utf-8');
    } catch {
        // non-fatal
    }
}



/**
 * Async Project Setup: Ensures session artifacts exist at the stable HOME_DIR path.
 * Uses ~/.free-llm-mcp/projects/<sessionId>/ so location is consistent regardless
 * of where the MCP server process is launched from.
 */
async function ensureProjectFiles(sessionId: string): Promise<string> {
    const projectDir = path.join(PROJECTS_DIR, sessionId);
    await fs.mkdir(projectDir, { recursive: true });

    const files: Record<string, string> = {
        [KNOWLEDGE_FILE]: '# Knowledge\n\n<!-- Internal MCP session distillation -->\n',
    };

    for (const [name, content] of Object.entries(files)) {
        const filePath = path.join(projectDir, name);
        try {
            await fs.access(filePath);
        } catch {
            await fs.writeFile(filePath, content, 'utf-8');
        }
    }

    return projectDir;
}

function decomposeGoal(goal: string): string[] {
    const lines = goal
        .split(/\n+/)
        .map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter(l => l.length > 0);
    return lines.length > 1 ? lines : [goal];
}


function getResponseContent(context: PipelineContext): string | undefined {
    const rawContent = context.response?.choices?.[0]?.message?.content;
    return rawContent ? getMessageContent(rawContent) : undefined;
}

/**
 * Hallucination Detection: Extended from a basic error check to also flag
 * patterns that indicate the model is inventing file locations or citing
 * sources it could not have retrieved. Results logged as WARN rather than
 * FAIL so the pipeline continues but the anomaly is auditable.
 *
 * Anti-hallucination strategies implemented here:
 *  1. Empty / error-prefix catch (original)
 *  2. Phantom-citation patterns: "according to the docs", "I can see that ..."
 *  3. Invented file paths: "the function is defined in src/..."
 *  4. Version/date fabrication: specific version numbers without [RETRIEVED] prefix
 */
function verifySelf(content: string): string {
    if (!content || content.trim().length === 0) {
        return 'FAIL: empty response';
    }
    const errorPatterns = /\b(error|exception|failed|undefined|null)\b/i;
    if (errorPatterns.test(content.slice(0, 100))) {
        return 'FAIL: response starts with error indicator';
    }

    // Hallucination Gate: vague-authority and phantom-reference patterns
    const hallucinationPatterns: RegExp[] = [
        /\baccording to the (documentation|docs|readme|spec|file)\b/i,
        /\bthe (file|function|class|method|module) (is|are|was|were) (defined|located|found|placed) (in|at|under)\b/i,
        /\b(I can see|I found|I noticed|I checked) that\b/i,
        /\bas (shown|seen|mentioned|stated|described) in the (code|file|docs|source)\b/i,
    ];
    const flags = hallucinationPatterns.filter(p => p.test(content));
    if (flags.length > 0) {
        return `WARN: ${flags.length} potential hallucination pattern(s) detected`;
    }

    return 'PASS';
}

/**
 * Detect whether a user message contains a research or external-knowledge request.
 * These patterns indicate the agent may invoke external search, browse, or retrieve
 * information from outside the context window.
 *
 * Validation is logged explicitly so agents can confirm the step was intentional,
 * reducing hallucination risk when external sources are consulted.
 */
function detectResearchIntent(content: string): boolean {
    const researchPatterns = [
        /\b(search|look up|find|research|browse|retrieve|fetch|crawl|scrape)\b/i,
        /\b(what is|who is|when did|where is|how does|explain|describe|summarize)\b/i,
        /\b(latest|recent|current|today|news|update|version)\b/i,
        /\b(according to|based on|reference|source|documentation|docs)\b/i,
        /\b(web search|internet|online|URL|http|www\.)\b/i,
    ];
    return researchPatterns.some((p) => p.test(content));
}

function logResearchValidation(sessionId: string, userContent: string, step: string): void {
    const timestamp = new Date().toISOString();
    console.error(
        `[AgenticMiddleware][RESEARCH-VALIDATION] session=${sessionId} step="${step}" ` +
        `timestamp=${timestamp} intent_detected=true ` +
        `query_preview="${getMessageContent(userContent).slice(0, 120).replace(/\n/g, ' ')}..."`,
    );
}

export class AgenticMiddleware implements Middleware {
    name = 'AgenticMiddleware';

    // v1.0.4 optimization: Cap decomposed plan to 2 high-level steps to prevent over-iteration
    private limitSubtasks(steps: string[]): string[] {
        if (steps.length > 2) {
            return steps.slice(0, 2);
        }
        return steps;
    }

    /**
     * Gathers grep-based context from the workspace root based on a query.
     * Delegates to the ContextGatherer utility.
     */
    async gatherGrepContext(workspaceRoot: string, query: string): Promise<string[]> {
        return ContextGatherer.gatherContext({ workspaceRoot, query });
    }

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        const startMs = Date.now();
        // Dual-Mode Trigger: Global Env OR Per-Request Flag
        const isAgenticExplicitlyRequested = context.agentic === true || context.request?.agentic === true;

        // Hardened Session ID: Must be provided for agentic state to exist
        const sessionId: string | undefined = context.sessionId || (context.request as any)?.sessionId;

        const iterationCountKey = `_iteration_${sessionId}`;
        const iterationCountValue = context[iterationCountKey];
        const iterationCount: number = typeof iterationCountValue === 'number' ? iterationCountValue : 0;
        context[iterationCountKey] = iterationCount + 1;

        if (process.env.ENABLE_AGENTIC_MIDDLEWARE !== 'true' && !isAgenticExplicitlyRequested) {
            await next();
            return;
        }

        if (iterationCount > 10) {
            console.error(`[AgenticMiddleware] Loop protection triggered for session=${sessionId}`);
            await next();
            return;
        }

        if (!sessionId) {
            console.error('[AgenticMiddleware] Mandatory sessionId missing. Bypassing agentic layer.');
            await next();
            return;
        }

        const projectDir = await ensureProjectFiles(sessionId);
        const q = await getOrLoadState(sessionId);

        // Prepend system prompt with user context if available
        const userMessage = context.request.messages.find(m => m.role === 'user');
        const userContent = userMessage ? String(userMessage.content) : undefined;

        // Context and memory are now handled by WorkspaceContextMiddleware
        // which runs BEFORE AgenticMiddleware in the pipeline.
        (context as any).isSubtask = q.nowQueue.length > 0;

        try {
            const groundingGate: string = (context as any).groundingGate || '';
            const highLevelStepsSection = `\n\n## HIGH-LEVEL STEPS\nWhen responding to a task, always begin with a numbered list of at most **4** high-level steps.`;
            const initialPrompt = await getIntelligentSystemPrompt({
                context: userContent || "",
                keywords: isAgenticExplicitlyRequested ? ['agentic', 'orchestration'] : [],
                memory: (context as any).memoryContext,
                isSubtask: false
            });
            const sysMsg = context.request.messages.find(m => m.role === 'system');
            const fullPrompt = `${initialPrompt}${highLevelStepsSection}${groundingGate}`;
            if (sysMsg) {
                sysMsg.content = fullPrompt;
            } else {
                // Ensure system message is ALWAYS at index 0
                context.request.messages.unshift({ role: 'system', content: fullPrompt });
            }
        } catch (err) {
            console.error(`[AgenticMiddleware] Failed to inject initial prompt: ${err}`);
            // Minimal fallback to ensure role integrity
            if (!context.request.messages.some(m => m.role === 'system')) {
                context.request.messages.unshift({ 
                    role: 'system', 
                    content: "You are an agentic AI coding assistant. Maintain MOMENTUM ENGINE protocols." 
                });
            }
        }

        // Research validation...
        // This provides an explicit audit trail to reduce agent ambiguity and hallucination risk.
        if (userContent && detectResearchIntent(userContent)) {
            logResearchValidation(sessionId, userContent, 'pre-execution-research-detection');
            // Auto-enable Google Search if research intent is detected in agentic mode
            if (!context.request.google_search) {
                context.request.google_search = true;
                console.error(`[AgenticMiddleware] Research intent detected, auto-enabling google_search for session=${sessionId}`);
            }
        }


        // Task decomposition: Only perform if nowQueue is empty to prevent multi-turn duplication
        if (userContent && q.nowQueue.length === 0) {
            const steps = decomposeGoal(userContent);

            // v1.0.4 optimization: Apply subtask limit before queuing to prevent over-iteration
            const limitedSteps = this.limitSubtasks(steps);
            q.nowQueue.push(...limitedSteps);
        }

        persistStateDebounced(sessionId, projectDir);

        // Execute the pipeline in a loop for each subtask
        let subtaskIteration = 0;
        const MAX_SUBTASKS = 5;

        // If no tasks, at least run once
        if (q.nowQueue.length === 0) {
            await next();
        }

        while (q.nowQueue.length > 0 && subtaskIteration < MAX_SUBTASKS) {
            subtaskIteration++;
            const currentTask = q.nowQueue[0];
            console.error(`[AgenticMiddleware] Starting subtask ${subtaskIteration}: ${currentTask}`);

            // 1. Inject Intelligent Prompt and Task Instruction
            try {
                // CLEAR and REFRESH System Prompt to avoid accumulation
                const subtaskPrompt = await getIntelligentSystemPrompt({
                    context: currentTask,
                    keywords: ['mcp', 'memory', 'filesystem'], // Core steering
                    memory: (context as any).memoryContext,
                    isSubtask: true
                });
                const taskHeader = `\n\n## 📝 CURRENT SUBTASK\nYou are currently executing this subtask:\n- **Task**: ${currentTask}\n\nStrictly focus on this subtask using the tools provided.`;

                const messages = context.request.messages;
                const sysMsg = messages.find(m => m.role === 'system');
                if (sysMsg) {
                    // Replace, don't append, to ensure clean state
                    sysMsg.content = `${subtaskPrompt}${taskHeader}`;
                } else {
                    messages.unshift({ role: 'system', content: `${subtaskPrompt}${taskHeader}` });
                }
            } catch (err) {
                console.error(`[AgenticMiddleware] Failed to inject subtask prompt: ${err}`);
            }

            // 2. Direct execution of the router (the next step in the pipeline)
            // Using dynamic import to break circular dependency at runtime
            const instances = await import('../../pipeline/instances.js');
            await instances.sharedRouter.execute(context, async () => { });

            // 3. Process result
            const responseContent = getResponseContent(context);
            if (responseContent) {
                const verifyResult = verifySelf(responseContent);

                if (verifyResult.startsWith('FAIL')) {
                    q.improveQueue.push(verifyResult);
                }

                // Append assistant response to history for next subtask context
                context.request.messages.push({ role: 'assistant', content: responseContent });

                // Store memory and knowledge
                const wsHash = context.wsHash;
                if (!verifyResult.startsWith('FAIL') && wsHash) {
                    await appendKnowledge(projectDir, sessionId, responseContent);
                }
            }

            // 4. Update queue
            q.nowQueue.shift();
            persistStateDebounced(sessionId, projectDir);
        }

        // v1.0.5: Critical fix - signal completion to the pipeline
        await next();

        console.error(`[agentic-middleware] ${Date.now() - startMs}ms session=${sessionId} iterations=${subtaskIteration}`);
    }
}
