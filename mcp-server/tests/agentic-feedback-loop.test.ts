import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { AgenticMiddleware, detectHallucination, summarizeResponse, extractCues } from '../src/middleware/agentic/agentic-middleware.js';
import { ContextGatherer } from '../src/middleware/agentic/context-gatherer.js';
import type { PipelineContext } from '../src/pipeline/middleware.js';

describe('Agentic Middleware Feedback Loop Tests', () => {
    const testDir = path.join(os.tmpdir(), 'mcp-loop-test-' + Date.now());

    beforeEach(async () => {
        await fs.ensureDir(testDir);
    });

    afterEach(async () => {
        await fs.remove(testDir);
        vi.restoreAllMocks();
    });

    it('detects context-request signal', () => {
        const signalPatterns = [
            "could you provide", "I need more context", "I don't have access to",
            "can you share", "please provide the", "what is the value of"
        ];
        
        const detectSignal = (text: string) => {
            return signalPatterns.some(p => text.toLowerCase().includes(p.toLowerCase()));
        };

        expect(detectSignal("I need more context regarding the auth key")).toBe(true);
        expect(detectSignal("Could you provide the file path?")).toBe(true);
        expect(detectSignal("Normal response explaining the logic")).toBe(false);
    });

    it('writes subtask prompts and responses to agentic-debug.log', async () => {
        const middleware = new AgenticMiddleware();
        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: 'run momentum' }]
            },
            agentic: true,
            sessionId: 'test-session-logging'
        } as any;

        // Spy on ContextGatherer.gatherContext
        const gatherSpy = vi.spyOn(ContextGatherer, 'gatherContext').mockResolvedValue([]);

        // Mock sharedRouter to return a context request
        const instances = await import('../src/pipeline/instances.js');
        const routerSpy = vi.spyOn(instances.sharedRouter, 'execute').mockImplementation(async (ctx, next) => {
            ctx.response = {
                choices: [{
                    message: {
                        content: 'I need more context regarding auth.ts'
                    }
                }]
            } as any;
        });

        await middleware.execute(context, async () => {});

        const logPath = path.join(os.homedir(), '.free-llm-mcp', 'projects', 'test-session-logging', 'agentic-debug.log');
        const logExists = await fs.pathExists(logPath);
        expect(logExists).toBe(true);

        const logContent = await fs.readFile(logPath, 'utf8');
        expect(logContent).toContain('test-session-logging');
        expect(logContent).toContain('I need more context regarding auth.ts');
    });

    it('injects CONTEXT-UNAVAILABLE when entity is not found in the workspace', async () => {
        const middleware = new AgenticMiddleware();
        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: 'run momentum' }]
            },
            agentic: true,
            sessionId: 'test-session-unavailable'
        } as any;

        // Mock no context found
        const gatherSpy = vi.spyOn(ContextGatherer, 'gatherContext').mockResolvedValue([]);

        const instances = await import('../src/pipeline/instances.js');
        let callCount = 0;
        const routerSpy = vi.spyOn(instances.sharedRouter, 'execute').mockImplementation(async (ctx, next) => {
            callCount++;
            if (callCount === 1) {
                ctx.response = {
                    choices: [{
                        message: {
                            content: 'I need more context regarding auth.ts'
                        }
                    }]
                } as any;
            } else {
                ctx.response = {
                    choices: [{
                        message: {
                            content: 'Proceeding without auth.ts.'
                        }
                    }]
                } as any;
            }
        });

        await middleware.execute(context, async () => {});

        // Check if CONTEXT-UNAVAILABLE was injected
        const lastUserMessage = context.request.messages.find(m => m.role === 'user' && m.content.includes('[CONTEXT-UNAVAILABLE]'));
        expect(lastUserMessage).toBeDefined();
        expect(lastUserMessage?.content).toContain('auth.ts was not found');
    });

    it('summarizeResponse limits response to 2000 chars, keeping first 500 chars verbatim', () => {
        const first500 = 'A'.repeat(500);
        const restOfText = ' Sentence containing important keywords like elephant and giraffe. '.repeat(100);
        const longResponse = first500 + restOfText;

        const summarized = summarizeResponse(longResponse);
        expect(summarized.length).toBeLessThanOrEqual(2000);
        expect(summarized.substring(0, 500)).toBe(first500);
        expect(summarized).toContain('<!-- TF-IDF SUMMARY -->');
        expect(summarized).toContain('elephant');
        expect(summarized).toContain('giraffe');
    });

    it('extractCues extracts files, functions, variables, and constants', () => {
        const text = 'I need to read index.js to find the function getUser() and check if JWT_SECRET is set via authMiddleware.';
        const cues = extractCues(text);
        expect(cues).toContain('index.js');
        expect(cues).toContain('getUser');
        expect(cues).toContain('JWT_SECRET');
        expect(cues).toContain('authMiddleware');
    });
});
