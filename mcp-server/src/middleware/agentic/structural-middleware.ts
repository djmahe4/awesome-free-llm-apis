import { Middleware, PipelineContext, NextFunction } from '../../pipeline/index.js';
import path from 'path';
import fs from 'fs-extra';
import { 
    PROJECTS_DIR, 
    STATE_FILE, 
    KNOWLEDGE_FILE,
    SESSION_STATE_HEADER 
} from './constants.js';
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

            const contextHeader = `${SESSION_STATE_HEADER}\n# INTERNAL DIAGNOSTICS (session ${sessionId})\n${fullMemory}\n\n# RESPONSE FORMAT\nReply only in clean Markdown. For any code or file changes use exactly this block:\n\`\`\`file:relative/path/from/session/root.ts\n// FULL file content here (never partial diffs)\n\`\`\``;

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
        const projectDir = path.join(PROJECTS_DIR, sessionId);

        const [stateRes, knowledgeRes] = await Promise.all([
            fs.pathExists(path.join(projectDir, STATE_FILE)).then(exists => exists ? fs.readFile(path.join(projectDir, STATE_FILE), 'utf-8') : null),
            fs.pathExists(path.join(projectDir, KNOWLEDGE_FILE)).then(exists => exists ? fs.readFile(path.join(projectDir, KNOWLEDGE_FILE), 'utf-8') : null),
        ]);

        const sections: string[] = [];

        // 1. INTERNAL QUEUE STATE
        if (stateRes) {
            try {
                const state = JSON.parse(stateRes);
                const queueBlock = [
                    state.nowQueue?.length ? `**Current:**   ${state.nowQueue.join(', ')}` : null,
                    state.nextQueue?.length ? `**Upcoming:**  ${state.nextQueue.join(', ')}` : null,
                    state.blockedQueue?.length ? `**Blocked:**   ${state.blockedQueue.join(', ')}` : null,
                ].filter(Boolean).join('\n');
                if (queueBlock) {
                    sections.push(`### QUEUE DIAGNOSTICS\n${queueBlock}`);
                }
            } catch (err) {
                console.error(`[structural-middleware] Failed to parse state.json: ${err}`);
            }
        }

        // 2. DISTILLED KNOWLEDGE
        if (knowledgeRes) {
            const extracted = await extractMdContext(knowledgeRes, 2000);
            if (extracted && extracted.length > 50) {
                sections.push(`### SESSION DISTILLATION\n${extracted}`);
            }
        }

        if (sections.length === 0) {
            return 'No prior state – starting fresh session.';
        }

        return sections.join('\n\n---\n\n');
    }
}
