import { Middleware, PipelineContext, NextFunction } from '../../pipeline/index.js';
import * as path from 'path';
import fs from 'fs-extra';
import { extractMdContext } from '../../utils/md-extract.js';

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


        // v1.0.4 Optimization: Parallelize all session file I/O
        const [planRes, queuesRes, tasksRes, knowledgeRes] = await Promise.all([
            fs.pathExists(path.join(projectDir, 'plan.md')).then(exists => exists ? fs.readFile(path.join(projectDir, 'plan.md'), 'utf-8') : null),
            fs.pathExists(path.join(projectDir, 'queues.json')).then(exists => exists ? fs.readFile(path.join(projectDir, 'queues.json'), 'utf-8') : null),
            fs.pathExists(path.join(projectDir, 'tasks.md')).then(exists => exists ? fs.readFile(path.join(projectDir, 'tasks.md'), 'utf-8') : null),
            fs.pathExists(path.join(projectDir, 'knowledge.md')).then(exists => exists ? fs.readFile(path.join(projectDir, 'knowledge.md'), 'utf-8') : null),
        ]);

        const sections: string[] = [];

        // v1.0.4 Hardening: Only add sections if they have substantive content
        // (beyond just echoing the section title or metadata).
        const isSubstantive = (text: string) => {
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length === 0) return false;

            // If any line is a list item, code block, or prose (no # or [META: or <!--)
            if (lines.some(l => !l.startsWith('#') && !l.startsWith('[META:') && !l.startsWith('<!--'))) return true;

            // If all we have are headings/meta, check if there are multiple headings
            // (e.g. # MISSION PLAN followed by # Phase 1 is substantive)
            const contentLines = lines.filter(l => !l.startsWith('[META:') && !l.startsWith('<!--'));
            return contentLines.length > 1;
        };

        // 1. MISSION PLAN
        if (planRes) {
            const extracted = await extractMdContext(planRes, 1500);
            if (extracted && isSubstantive(extracted)) {
                sections.push(`## MISSION PLAN\n${extracted}`);
                console.error(`[structural-middleware] Loaded plan.md (extracted ${extracted.length}b)`);
            }
        }

        // 2. TASK QUEUE
        if (queuesRes) {
            try {
                const queues = JSON.parse(queuesRes);
                const queueBlock = [
                    queues.nowQueue?.length ? `**Now:**      ${queues.nowQueue.join(', ')}` : null,
                    queues.nextQueue?.length ? `**Next:**     ${queues.nextQueue.join(', ')}` : null,
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

        // 3. ACTIVE TASKS
        if (tasksRes) {
            const extracted = await extractMdContext(tasksRes, 1500);
            if (extracted && isSubstantive(extracted)) {
                sections.push(`## ACTIVE TASKS\n${extracted}`);
            }
        }

        // 4. SESSION KNOWLEDGE
        if (knowledgeRes) {
            const extracted = await extractMdContext(knowledgeRes, 1500);
            if (extracted && isSubstantive(extracted)) {
                sections.push(`## SESSION KNOWLEDGE\n${extracted}`);
            }
        }

        if (sections.length === 0) {
            return 'No prior state – starting fresh session.';
        }

        return sections.join('\n\n---\n\n');
    }
}
