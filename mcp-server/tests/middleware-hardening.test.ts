import { describe, it, expect, vi } from 'vitest';
import { AgenticMiddleware } from '../src/middleware/agentic/agentic-middleware.js';
import { StructuralMarkdownMiddleware } from '../src/middleware/agentic/structural-middleware.js';
import { TokenManagerMiddleware } from '../src/pipeline/middlewares/TokenManagerMiddleware.js';
import { PipelineContext, TaskType } from '../src/pipeline/middleware.js';

describe('Middleware Hardening - Non-String Content', () => {
    it('AgenticMiddleware should NOT crash when response content is an object', async () => {
        const middleware = new AgenticMiddleware();
        const context: PipelineContext = {
            sessionId: 'test-session',
            request: {
                messages: [{ role: 'user', content: 'hello' }]
            },
            response: {
                choices: [{
                    message: {
                        role: 'assistant',
                        content: { plan: 'structured plan' } as any
                    }
                }]
            } as any
        };

        // This would traditionally crash in verifySelf due to content.slice(0, 100)
        await expect(middleware.execute(context, async () => { })).resolves.not.toThrow();
    });

    it('TokenManagerMiddleware should NOT crash when message content is an array', async () => {
        const middleware = new TokenManagerMiddleware();
        const context: PipelineContext = {
            providerId: 'mock-provider',
            request: {
                messages: [{
                    role: 'user',
                    content: [{ type: 'text', text: 'hi' }] as any
                }]
            }
        };

        // This would traditionally crash due to this.encoder.encode(msg.content)
        await expect(middleware.execute(context, async () => { })).resolves.not.toThrow();
    });

    it('StructuralMarkdownMiddleware should bypass memory injection if sessionId is missing', async () => {
        const middleware = new StructuralMarkdownMiddleware();
        const context: PipelineContext = {
            request: {
                agentic: true,
                messages: [{ role: 'user', content: 'original prompt' }]
            }
        } as any;

        const next = vi.fn();
        await middleware.execute(context, next);

        expect(next).toHaveBeenCalled();
        // Message content should NOT have been modified with memory injection
        expect(context.request?.messages![0].content).toBe('original prompt');
    });
});
