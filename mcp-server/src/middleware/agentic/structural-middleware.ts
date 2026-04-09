import { Middleware, PipelineContext, NextFunction } from '../../pipeline/index.js';
import * as path from 'path';
import * as fs from 'fs-extra';

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
                console.error(`[structural-middleware] Rejected invalid or missing sessionId: ${sessionIdRaw}`);
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

        const knowledgePath = path.join(projectDir, 'knowledge.md');
        if (await fs.pathExists(knowledgePath)) {
            return await fs.readFile(knowledgePath, 'utf-8');
        }
        return 'No prior memory – starting fresh session.';
    }
}
