import { describe, it, expect, vi } from 'vitest';
import {
    TaskType,
    type PipelineContext,
    IntelligentRouterMiddleware
} from '../src/pipeline/index.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { BaseProvider } from '../src/providers/base.js';

class MockProvider extends BaseProvider {
    name = 'Mock';
    id = 'mock';
    baseURL = 'http://mock';
    envVar = 'MOCK_API_KEY';
    // Use a model ID that is actually in the router's configuration (e.g., gemini-2.0-flash)
    models = [{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 32768 }];
    rateLimits = { rpm: 60 };
    constructor() {
        super();
        vi.stubEnv(this.envVar, 'mock-key-is-sufficiently-long');
    }
    override isAvailable(): boolean { return true; }
}

describe('Intelligent Router - Multi-modal Content Bug Repro', () => {
    it('should NOT crash when message content is an array (multi-modal)', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        registry.registerProvider(new MockProvider());

        // Multi-modal message content (Common in some SDKs/models)
        const context: PipelineContext = {
            request: {
                messages: [
                    { 
                        role: 'user', 
                        content: [
                            { type: 'text', text: 'what is an atom?' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                        ] as any
                    }
                ]
            },
            taskType: TaskType.Chat
        };

        const trySpy = vi.spyOn(executor, 'tryProvider').mockResolvedValue({ id: 'ok' } as any);

        // This should NOT throw "TypeError: content.toLowerCase is not a function"
        await expect(router.execute(context, async () => { })).resolves.not.toThrow();
        
        expect(trySpy).toHaveBeenCalled();
    });

    it('should correctly classify task type even with multi-modal content', async () => {
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        const content = [
            { type: 'text', text: 'solve this math problem: 2+2' }
        ];

        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: content as any }]
            }
        };

        // autoClassify is now synchronous and takes (messages, explicitKeywords)
        // We use (router as any) because it's a private method
        const taskType = (router as any).autoClassify(context.request.messages, context.keywords);
        context.taskType = taskType;
        
        // "2+2" should be classified as Chat or something similar (not empty)
        expect(context.taskType).toBeDefined();
        // Since "solve this math problem: 2+2" doesn't have explicit coding keywords, it will default to Chat
        expect(context.taskType).toBe(TaskType.Chat);
    });

    it('should NOT crash in decomposeAndExecute when subtasks are objects instead of strings', async () => {
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        // Simulate a complex prompt to trigger decomposition
        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: '1. do this\n2. do that\n3. then finally this' }]
            }
        };

        // Mock planner response returning objects in subtasks
        const plannerResponse = JSON.stringify([
            { task: 'Subtask 1' },
            { task: 'Subtask 2' }
        ]);

        vi.spyOn(executor, 'prompt').mockImplementation(async (msgs: any) => {
            // First call is for planning
            if (msgs[0].content.includes('JSON array of strings')) {
                return { choices: [{ message: { content: plannerResponse } }] } as any;
            }
            // Subsequent calls are for execution
            return { choices: [{ message: { content: 'Subtask result' } }] } as any;
        });

        const trySpy = vi.spyOn(executor, 'tryProvider').mockResolvedValue({ id: 'ok' } as any);

        // This should NOT throw "TypeError: task.slice is not a function"
        await expect((router as any).decomposeAndExecute(context)).resolves.not.toThrow();
        
        // Final response should contain the results
        expect(context.response?.choices[0].message.content).toContain('Subtask 1');
        expect(context.response?.choices[0].message.content).toContain('Subtask 2');
    });
});
