import { Middleware, PipelineContext, NextFunction } from '../../pipeline/index.js';
import * as path from 'path';
import fs from 'fs-extra';

export class StructuralMarkdownMiddleware implements Middleware {
    name = 'StructuralMarkdownMiddleware';

    async execute(context: PipelineContext, next: NextFunction) {
        const startMs = Date.now();
        // v1.0.4 Harden: Optional chaining and strict type guard
        const sessionIdRaw = context.sessionId || (context.request as any)?.sessionId;
        
        // v1.0.4 Security: Strict sessionId validation to prevent path traversal
        const sessionId = (typeof sessionIdRaw === 'string' && /^(?!\.\.?$)[\w\-\.]{1,128}$/.test(sessionIdRaw)) 
            ? sessionIdRaw 
            : undefined;

        // Tightened Guard: Bypass if not agentic OR missing mandatory/valid sessionId
        if (!context.request?.agentic || !sessionId) {
            if (context.request?.agentic && !sessionId) {
                const reason = sessionIdRaw ? 'invalid (Security Gate)' : 'missing';
                console.error(`[structural-middleware] Rejected ${reason} sessionId: ${sessionIdRaw}`);
            }
            await next();
            console.error(`[structural-middleware] ${Date.now() - startMs}ms (pass-through)`);
            return;
        }

        const userMsg = context.request.messages?.find(m => m.role === 'user');
        if (userMsg) {
            const memStart = Date.now();
            const fullMemory = await this.readFullSessionMemory(sessionId);
            console.error(`[memory-read] ${Date.now() - memStart}ms session=${sessionId}`);

            const contextHeader = `# TASK CONTEXT\n# FULL MEMORY STATE (session ${sessionId})\n${fullMemory}\n\n# RESPONSE FORMAT\nReply only in clean Markdown. For any code or file changes use exactly this block:\n\`\`\`file:relative/path/from/session/root.ts\n// FULL file content here (never partial diffs)\n\`\`\``;

            // v1.0.4 Robustness: Handle all valid message content formats (string, array, or object)
            if (typeof userMsg.content === 'string') {
                userMsg.content = `${contextHeader}\n\n${userMsg.content}`;
            } else if (Array.isArray(userMsg.content)) {
                // Prepend context as a new text block to avoid breaking multi-modal parts
                (userMsg.content as any[]).unshift({
                    type: 'text',
                    text: contextHeader
                });
            } else if (userMsg.content && typeof userMsg.content === 'object') {
                // Some SDKs might use a single object for content (e.g. { type: 'text', text: '...' })
                const contentObj = userMsg.content as any;
                if (contentObj.type === 'text' && typeof contentObj.text === 'string') {
                    contentObj.text = `${contextHeader}\n\n${contentObj.text}`;
                } else {
                    // Fallback: Convert to array if it's a non-standard object format
                    userMsg.content = [
                        { type: 'text', text: contextHeader },
                        contentObj
                    ];
                }
            }
        }
        await next();
        console.error(`[structural-middleware] ${Date.now() - startMs}ms`);
    }

    private async readFullSessionMemory(sessionId: string): Promise<string> {
        // v1.0.4 Security: Final path sanitization check
        const projectsBase = path.join(process.cwd(), 'data', 'projects');
        const projectDir = path.resolve(projectsBase, sessionId);

        // Ensure the resolved path is actually within the projects directory
        if (!projectDir.startsWith(projectsBase)) {
            console.error(`[structural-middleware] Blocked traversal attempt for sessionId: ${sessionId}`);
            return 'Security Error: Access denied.';
        }

        const sections: string[] = [];

        /**
         * Returns true only if the file contains lines with real content
         * beyond auto-generated scaffolding (HTML comments, headings).
         */
        const hasSubstantiveContent = (raw: string): boolean => {
            return raw
                .split('\n')
                .map(l => l.replace(/<!--.*?-->/gs, '').trim())
                .filter(l => l.length > 0 && !l.startsWith('#'))
                .some(l => l.length > 3);
        };

        // 1. MISSION PLAN — what the agent is supposed to do
        const planPath = path.join(projectDir, 'plan.md');
        if (await fs.pathExists(planPath)) {
            const planContent = (await fs.readFile(planPath, 'utf-8')).trim();
            if (hasSubstantiveContent(planContent)) {
                sections.push(`## MISSION PLAN\n${planContent}`);
                console.error(`[structural-middleware] Loaded plan.md (${planContent.length}b)`);
            }
        }

        // 2. TASK QUEUE — live queues persisted by AgenticMiddleware
        const queuesPath = path.join(projectDir, 'queues.json');
        if (await fs.pathExists(queuesPath)) {
            try {
                const queuesRaw = await fs.readFile(queuesPath, 'utf-8');
                const queues = JSON.parse(queuesRaw);
                const queueBlock = [
                    queues.nowQueue?.length    ? `**Now:**      ${queues.nowQueue.join(', ')}` : null,
                    queues.nextQueue?.length   ? `**Next:**     ${queues.nextQueue.join(', ')}` : null,
                    queues.blockedQueue?.length ? `**Blocked:**  ${queues.blockedQueue.join(', ')}` : null,
                    queues.improveQueue?.length ? `**Improve:**  ${queues.improveQueue.join(', ')}` : null,
                ].filter(Boolean).join('\n');
                if (queueBlock) {
                    sections.push(`## TASK QUEUE\n${queueBlock}`);
                    console.error(`[structural-middleware] Loaded queues.json (now=${queues.nowQueue?.length ?? 0} tasks)`);
                }
            } catch (err) {
                console.error(`[structural-middleware] Failed to parse queues.json: ${err}`);
            }
        }

        // 3. ACTIVE TASKS — markdown task list (tasks.md)
        const tasksPath = path.join(projectDir, 'tasks.md');
        if (await fs.pathExists(tasksPath)) {
            const tasksContent = (await fs.readFile(tasksPath, 'utf-8')).trim();
            if (hasSubstantiveContent(tasksContent)) {
                sections.push(`## ACTIVE TASKS\n${tasksContent}`);
                console.error(`[structural-middleware] Loaded tasks.md (${tasksContent.length}b)`);
            }
        }

        // 4. SESSION KNOWLEDGE — persistent learnings (knowledge.md)
        const knowledgePath = path.join(projectDir, 'knowledge.md');
        if (await fs.pathExists(knowledgePath)) {
            const knowledgeContent = (await fs.readFile(knowledgePath, 'utf-8')).trim();
            if (hasSubstantiveContent(knowledgeContent)) {
                sections.push(`## SESSION KNOWLEDGE\n${knowledgeContent}`);
                console.error(`[structural-middleware] Loaded knowledge.md (${knowledgeContent.length}b)`);
            }
        }

        if (sections.length === 0) {
            return 'No prior state – starting fresh session.';
        }

        return sections.join('\n\n---\n\n');
    }
}
