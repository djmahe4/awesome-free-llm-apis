import { Middleware, PipelineContext, NextFunction } from '../../pipeline/index.js';
import * as path from 'path';
import * as fs from 'fs-extra';

export class StructuralMarkdownMiddleware implements Middleware {
    name = 'StructuralMarkdownMiddleware';

    async execute(context: PipelineContext, next: NextFunction) {
        console.time('structural-middleware');
        if (!context.request?.agentic) {
            console.timeEnd('structural-middleware');
            return next();
        }

        const userMsg = context.request.messages?.find((m: any) => m.role === 'user');
        if (userMsg) {
            console.time('memory-read');
            // AgenticMiddleware enforces mandatory sessionId; 'default' is only reached in
            // direct/standalone use of this middleware outside the standard agentic pipeline.
            const fullMemory = await this.readFullSessionMemory(context.sessionId || 'default');
            console.timeEnd('memory-read');
            userMsg.content = `# TASK CONTEXT\n${userMsg.content}\n\n# FULL MEMORY STATE (session ${context.sessionId})\n${fullMemory}\n\n# RESPONSE FORMAT\nReply only in clean Markdown. For any code or file changes use exactly this block:\n\`\`\`file:relative/path/from/session/root.ts\n// FULL file content here (never partial diffs)\n\`\`\``;
        }
        await next();
        console.timeEnd('structural-middleware');
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
