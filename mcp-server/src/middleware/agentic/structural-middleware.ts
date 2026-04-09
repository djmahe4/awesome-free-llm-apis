import { Middleware, PipelineContext, NextFunction } from '../../pipeline/index.js';
import * as path from 'path';
import * as fs from 'fs-extra';

export class StructuralMarkdownMiddleware implements Middleware {
    name = 'StructuralMarkdownMiddleware';

    async execute(context: PipelineContext, next: NextFunction) {
        const startMs = Date.now();
        const sessionId = context.sessionId || (context.request as any).sessionId;

        // Tightened Guard: Bypass if not agentic OR missing mandatory sessionId
        if (!context.request?.agentic || !sessionId) {
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

            if (typeof userMsg.content === 'string') {
                userMsg.content = `${contextHeader}\n\n${userMsg.content}`;
            } else if (Array.isArray(userMsg.content)) {
                // Prepend context as a new text block to avoid breaking multi-modal parts
                (userMsg.content as any[]).unshift({
                    type: 'text',
                    text: contextHeader
                });
            }
        }
        await next();
        console.error(`[structural-middleware] ${Date.now() - startMs}ms`);
    }

    private async readFullSessionMemory(sessionId: string): Promise<string> {
        const dir = path.join(process.cwd(), 'data', 'projects', sessionId);
        const knowledgePath = path.join(dir, 'knowledge.md');
        if (await fs.pathExists(knowledgePath)) {
            return await fs.readFile(knowledgePath, 'utf-8');
        }
        return 'No prior memory – starting fresh session.';
    }
}
