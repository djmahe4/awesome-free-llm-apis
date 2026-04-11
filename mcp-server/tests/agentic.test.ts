import crypto from 'node:crypto';
import path from 'node:path';
import { AgenticMiddleware } from '../src/middleware/agentic/agentic-middleware.js';
import { getIntelligentSystemPrompt, resetPromptCache } from '../src/middleware/agentic/prompts.js';
import type { PipelineContext } from '../src/pipeline/middleware.js';
import fs, { promises as fsp } from 'fs';

// Mock FS module
vi.mock('fs', () => {
    const mockPromises = {
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        access: vi.fn(),
        readFile: vi.fn(),
        stat: vi.fn(),
    };
    return {
        default: {
            promises: mockPromises,
        },
        promises: mockPromises,
    };
});

describe('Agentic Intelligence & Middleware', () => {
    const mockPromptData = {
        metadata: { version: '1.0.3' },
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
        resetPromptCache();

        // Setup default mock behaviors (Async)
        (vi.mocked(fsp.access) as any).mockImplementation(async (path: string) => {
            if (path.endsWith('prompt.json') || path.endsWith('system-prompt-raw.md') || path.endsWith('README.md')) return undefined;
            throw new Error('File not found');
        });
        (vi.mocked(fsp.stat) as any).mockImplementation(async () => ({ mtimeMs: Date.now() }));
        (vi.mocked(fsp.readFile) as any).mockImplementation(async (path: string) => {
            if (path.endsWith('prompt.json')) return JSON.stringify(mockPromptData);
            if (path.endsWith('README.md')) return "Tier 2 Fallback (README)".padEnd(600, '!');
            return "";
        });

        vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
        vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
        (vi.mocked(fsp.stat) as any).mockResolvedValue({ mtimeMs: 1000 });
    });

    describe('getIntelligentSystemPrompt (Async)', () => {
        it('returns only intro + critical section when no context', async () => {
            const prompt = await getIntelligentSystemPrompt();
            expect(prompt).toContain("Agent Identity Core");
            expect(prompt).toContain("MOMENTUM ENGINE");
            expect(prompt).not.toContain("RELIABILITY MATH");
        });

        it('includes relevant section for keyword match', async () => {
            const prompt = await getIntelligentSystemPrompt("improve reliability");
            expect(prompt).toContain("RELIABILITY MATH");
        });

        it('granularly filters reference maps to only include relevant entries (token optimization)', async () => {
            const prompt = await getIntelligentSystemPrompt("tell me about temporal specifically");
            expect(prompt).toContain("RESEARCH APPENDIX");
            expect(prompt).toContain("Temporal");
            expect(prompt).toContain("Durable execution engine");

            // Should filter out irrelevant entries to save tokens
            expect(prompt).not.toContain("Stripe");
            expect(prompt).not.toContain("Twilio");
        });

        it('injects REFERENCE_SUGGESTION_PROTOCOL when a reference section matches', async () => {
            const prompt = await getIntelligentSystemPrompt("search appendix for temporal");
            expect(prompt).toContain("REFERENCE SUGGESTION PROTOCOL");
            expect(prompt).toContain("Provide the direct URL");
        });

        it('boosts reference sections when architectural keywords are used', async () => {
            // "api" keyword is in the booster list but not in the default keywords for research_appendix
            const prompt = await getIntelligentSystemPrompt("api references");
            expect(prompt).toContain("RESEARCH APPENDIX");
        });

        it('falls back to Tier 2 (README) if prompt.json is missing', async () => {
            (vi.mocked(fsp.stat) as any).mockImplementation(async (path: string) => {
                if (path.endsWith('prompt.json')) throw new Error('Not found');
                return { mtimeMs: 1000 };
            });
            const prompt = await getIntelligentSystemPrompt();
            expect(prompt).toContain("Tier 2 Fallback (README)");
        });

        it('falls back to Tier 2 if prompt.json is invalid JSON', async () => {
            (vi.mocked(fsp.readFile) as any).mockImplementation(async (path: string) => {
                if (path.endsWith('prompt.json')) return "INVALID JSON";
                if (path.endsWith('README.md')) return "Tier 2 Fallback (README)".padEnd(600, '!');
                return "";
            });
            const prompt = await getIntelligentSystemPrompt();
            expect(prompt).toContain("Tier 2 Fallback (README)");
        });

        it('falls back to hardcoded default if all files are missing', async () => {
            (vi.mocked(fsp.stat) as any).mockImplementation(async (path: string) => {
                throw new Error('Not found');
            });
            (vi.mocked(fsp.access) as any).mockRejectedValue(new Error('Not found'));
            const prompt = await getIntelligentSystemPrompt();
            expect(prompt).toContain("You are the principal architect");
        });

        it('invalidates cache when prompt.json mtime changes', async () => {
            // First call matches default mtime 1000
            await getIntelligentSystemPrompt();
            expect(fsp.readFile).toHaveBeenCalledTimes(1);

            // Second call with same mtime should use cache
            await getIntelligentSystemPrompt();
            expect(fsp.readFile).toHaveBeenCalledTimes(1);

            // Update mtime to trigger reload
            (vi.mocked(fsp.stat) as any).mockResolvedValue({ mtimeMs: 2000 });
            await getIntelligentSystemPrompt();
            expect(fsp.readFile).toHaveBeenCalledTimes(2);
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
            // Debounced: wait for queues.json write (2000ms debounce + buffer)
            await new Promise(resolve => setTimeout(resolve, 2100));
            // queues.json is written twice (pre/post execution) - check for either
            const writeCalls = fsp.writeFile.mock.calls;
            const queuesCall = writeCalls.find(call => 
                typeof call[0] === 'string' && call[0].includes('queues.json')
            );
            expect(queuesCall).toBeDefined();
            expect(queuesCall![1]).toContain('Step'); // Contains decomposed steps
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

        it('bypasses agentic processing if sessionId is missing (Strict Enforcement)', async () => {
            const middleware = new AgenticMiddleware();
            const context: PipelineContext = {
                request: {
                    model: 'test',
                    messages: [{ role: 'user', content: 'momentum' }]
                }
                // No sessionId
            } as any;

            const next = vi.fn();
            await middleware.execute(context, next);

            expect(next).toHaveBeenCalled();
            expect(context.request.messages.length).toBe(1); // No system prompt prepended
            expect(fsp.mkdir).not.toHaveBeenCalled(); // No directory created
        });

        it('supports deterministic sessionId derivation (Namespaced)', async () => {
            const middleware = new AgenticMiddleware();
            const workspacePath = 'c:/my/project';

            // Mirror logic: ws-[sha256(path)]
            const normalized = path.resolve(workspacePath).replace(/\\/g, '/');
            const expectedHash = crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
            const expectedSessionId = `ws-${expectedHash}`;

            const context: PipelineContext = {
                request: {
                    model: 'test',
                    messages: [{ role: 'user', content: 'hello' }]
                },
                sessionId: expectedSessionId
            } as any;

            await middleware.execute(context, vi.fn());

            // Verifies that the middleware correctly handles IDs generated by the tool layer
            expect(fsp.mkdir).toHaveBeenCalledWith(
                expect.stringContaining(expectedSessionId),
                expect.any(Object)
            );
        });
    });
});
