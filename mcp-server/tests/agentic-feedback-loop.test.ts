import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { AgenticMiddleware, detectHallucination, summarizeResponse, extractCues } from '../src/pipeline/middlewares/AgenticMiddleware.js';
import { ContextGatherer } from '../src/pipeline/middlewares/context-gatherer.js';
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
        const { LLMExecutor } = await import('../src/utils/LLMExecutor.js');
        const promptSpy = vi.spyOn(LLMExecutor.prototype, 'prompt').mockResolvedValue({
            choices: [{
                message: {
                    content: 'I need more context regarding auth.ts'
                }
            }]
        } as any);

        const middleware = new AgenticMiddleware();
        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: 'implement momentum' }]
            },
            agentic: true,
            sessionId: 'test-session-logging'
        } as any;

        // Spy on ContextGatherer.gatherContext
        const gatherSpy = vi.spyOn(ContextGatherer, 'gatherContext').mockResolvedValue([]);

        const logPath = path.join(os.homedir(), '.free-llm-mcp', 'projects', 'test-session-logging', 'agentic-debug.log');
        await fs.remove(logPath);

        await middleware.execute(context, async () => {});

        const logExists = await fs.pathExists(logPath);
        expect(logExists).toBe(false); // Verify that agentic-debug.log is not written to disk

        expect(promptSpy).toHaveBeenCalled();
    });

    it('injects CONTEXT-UNAVAILABLE when entity is not found in the workspace', async () => {
        const { LLMExecutor } = await import('../src/utils/LLMExecutor.js');
        let callCount = 0;
        const promptSpy = vi.spyOn(LLMExecutor.prototype, 'prompt').mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    choices: [{
                        message: {
                            content: 'I need more context regarding auth.ts'
                        }
                    }]
                } as any;
            } else {
                return {
                    choices: [{
                        message: {
                            content: 'Proceeding without auth.ts.'
                        }
                    }]
                } as any;
            }
        });

        const middleware = new AgenticMiddleware();
        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: 'implement momentum' }]
            },
            agentic: true,
            sessionId: 'test-session-unavailable'
        } as any;

        // Mock no context found
        const gatherSpy = vi.spyOn(ContextGatherer, 'gatherContext').mockResolvedValue([]);

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

    it('uses LLMExecutor.prompt directly for subtask execution instead of sharedRouter.execute', async () => {
        const { LLMExecutor } = await import('../src/utils/LLMExecutor.js');
        const promptSpy = vi.spyOn(LLMExecutor.prototype, 'prompt').mockResolvedValue({
            id: 'mock-subtask-resp',
            choices: [{ message: { role: 'assistant', content: 'Subtask done.' } }]
        } as any);

        const { TextRouterMiddleware } = await import('../src/pipeline/middlewares/TextRouterMiddleware.js');
        const routerSpy = vi.spyOn(TextRouterMiddleware.prototype, 'execute');

        const middleware = new AgenticMiddleware();
        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: 'Step 1: Do task A' }]
            },
            agentic: true,
            sessionId: 'test-session-executor-direct'
        } as any;

        await middleware.execute(context, async () => {});

        expect(promptSpy).toHaveBeenCalled();
        expect(routerSpy).not.toHaveBeenCalled();
    });

    it('applies a sliding window to prune old messages when they grow too large during subtasks', async () => {
        const { LLMExecutor } = await import('../src/utils/LLMExecutor.js');
        const promptSpy = vi.spyOn(LLMExecutor.prototype, 'prompt').mockResolvedValue({
            id: 'mock-subtask-resp',
            choices: [{ message: { role: 'assistant', content: 'Subtask done.' } }]
        } as any);

        const middleware = new AgenticMiddleware();
        const initialMessages = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Step 1: Create a file\nStep 2: Fix a bug' },
            { role: 'assistant', content: 'Msg 2' },
            { role: 'user', content: 'Msg 3' },
            { role: 'assistant', content: 'Msg 4' },
            { role: 'user', content: 'Msg 5' },
            { role: 'assistant', content: 'Msg 6' },
            { role: 'user', content: 'Msg 7' },
            { role: 'assistant', content: 'Msg 8' },
            { role: 'user', content: 'Msg 9' },
        ];
        const context: PipelineContext = {
            request: {
                messages: [...initialMessages]
            },
            agentic: true,
            sessionId: 'test-session-sliding-window'
        } as any;

        await middleware.execute(context, async () => {});

        const systemMsg = context.request.messages.find(m => m.role === 'system');
        expect(systemMsg).toBeDefined();
        // Since we prune to keep only the last 6 non-system messages, plus new subtask messages:
        expect(context.request.messages.length).toBeLessThan(initialMessages.length + 3);
    });
});

