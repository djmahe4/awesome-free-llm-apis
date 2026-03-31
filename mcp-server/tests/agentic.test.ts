import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgenticMiddleware } from '../src/middleware/agentic/agentic-middleware.js';
import { getIntelligentSystemPrompt } from '../src/middleware/agentic/prompts.js';
import type { PipelineContext } from '../src/pipeline/middleware.js';
import fs, { promises as fsp } from 'fs';

// Mock FS module
vi.mock('fs', () => {
    const mockPromises = {
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        access: vi.fn(),
    };
    return {
        default: {
            existsSync: vi.fn(),
            readFileSync: vi.fn(),
            promises: mockPromises,
        },
        promises: mockPromises,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
    };
});

describe('Agentic Intelligence & Middleware', () => {
    const mockPromptData = {
        metadata: { version: '1.1.0' },
        introduction: "Agent Identity Core",
        sections: [
            {
                id: "momentum",
                title: "MOMENTUM ENGINE",
                content: "Keep moving through queues.",
                level: 1,
                keywords: ["momentum", "queues", "stall"]
            },
            {
                id: "reliability",
                title: "RELIABILITY MATH",
                content: "Ensure 99.9% reliability.",
                level: 2,
                keywords: ["reliability", "math", "failure"]
            },
            {
                id: "research_appendix",
                title: "RESEARCH APPENDIX",
                content: "- [Temporal](https://github.com/temporalio/temporal)\n  Durable execution engine.\n\n- [Stripe](https://stripe.com)\n  Payment infrastructure.\n\n- [Twilio](https://twilio.com)\n  Communications API.",
                level: 2,
                keywords: ["research", "appendix", "tools", "temporal", "stripe", "twilio"]
            }
        ]
    };

    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv('ENABLE_AGENTIC_MIDDLEWARE', 'true');
        
        // Setup default mock behaviors
        (vi.mocked(fs.existsSync) as unknown as any).mockImplementation((path: string) => path.endsWith('prompt.json'));
        (vi.mocked(fs.readFileSync) as unknown as any).mockImplementation((path: string) => {
            if (path.endsWith('prompt.json')) return JSON.stringify(mockPromptData);
            return "";
        });

        vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
        vi.mocked(fsp.access).mockResolvedValue(undefined);
        vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    });

    describe('getIntelligentSystemPrompt', () => {
        it('returns only intro + critical section when no context', () => {
            const prompt = getIntelligentSystemPrompt();
            expect(prompt).toContain("Agent Identity Core");
            expect(prompt).toContain("MOMENTUM ENGINE");
            expect(prompt).not.toContain("RELIABILITY MATH");
        });

        it('includes relevant section for keyword match', () => {
            const prompt = getIntelligentSystemPrompt("improve reliability");
            expect(prompt).toContain("RELIABILITY MATH");
        });

        it('granularly filters reference maps to only include relevant entries (token optimization)', () => {
            const prompt = getIntelligentSystemPrompt("tell me about temporal specifically");
            expect(prompt).toContain("RESEARCH APPENDIX");
            expect(prompt).toContain("Temporal");
            expect(prompt).toContain("Durable execution engine");
            
            // Should filter out irrelevant entries to save tokens
            expect(prompt).not.toContain("Stripe");
            expect(prompt).not.toContain("Twilio");
        });

        it('injects REFERENCE_SUGGESTION_PROTOCOL when a reference section matches', () => {
            const prompt = getIntelligentSystemPrompt("search appendix for temporal");
            expect(prompt).toContain("REFERENCE SUGGESTION PROTOCOL");
            expect(prompt).toContain("Provide the direct URL");
        });

        it('boosts reference sections when architectural keywords are used', () => {
            // "api" keyword is in the booster list but not in the default keywords for research_appendix
            const prompt = getIntelligentSystemPrompt("api references");
            expect(prompt).toContain("RESEARCH APPENDIX");
        });
    });

    describe('AgenticMiddleware', () => {
        it('prepends a tailored system prompt to the message list', async () => {
            const middleware = new AgenticMiddleware();
            const context: PipelineContext = {
                request: {
                    model: 'test',
                    messages: [{ role: 'user', content: 'momentum' }]
                },
                sessionId: 'session-1'
            } as any;

            await middleware.execute(context, vi.fn());

            const systemMessage = context.request.messages[0];
            expect(systemMessage.role).toBe('system');
            expect(systemMessage.content).toContain("MOMENTUM ENGINE");
        });

        it('performs task decomposition and persists queues', async () => {
            const middleware = new AgenticMiddleware();
            const context: PipelineContext = {
                request: {
                    model: 'test',
                    messages: [{ role: 'user', content: 'Step 1: Build\nStep 2: Test' }]
                },
                sessionId: 'session-2'
            } as any;

            // Force initialization by mocking access failure
            vi.mocked(fsp.access).mockRejectedValue(new Error('not found'));

            await middleware.execute(context, vi.fn());

            // Should have initialized project files
            expect(fsp.mkdir).toHaveBeenCalled();
            // Should have persisted queues
            expect(fsp.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('queues.json'),
                expect.stringContaining('Step 1: Build'),
                'utf-8'
            );
        });

        it('respects ENABLE_AGENTIC_MIDDLEWARE toggle', async () => {
            vi.stubEnv('ENABLE_AGENTIC_MIDDLEWARE', 'false');
            const middleware = new AgenticMiddleware();
            const context: PipelineContext = {
                request: { model: 'test', messages: [{ role: 'user', content: '...' }] },
                sessionId: 'session-3'
            } as any;

            await middleware.execute(context, vi.fn());
            expect(context.request.messages.length).toBe(1);
        });

        it('activates via context.agentic regardless of environment toggle', async () => {
            vi.stubEnv('ENABLE_AGENTIC_MIDDLEWARE', 'false');
            const middleware = new AgenticMiddleware();
            const context: PipelineContext = {
                request: { 
                    model: 'test', 
                    messages: [{ role: 'user', content: 'momentum' }] 
                },
                agentic: true,
                sessionId: 'explicit-session'
            } as any;

            await middleware.execute(context, vi.fn());

            const systemMessage = context.request.messages[0];
            expect(systemMessage.role).toBe('system');
            expect(systemMessage.content).toContain("MOMENTUM ENGINE");
        });
    });
});
