import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { PipelineExecutor } from '../src/pipeline/index.js';
import { AgenticMiddleware } from '../src/middleware/agentic/agentic-middleware.js';
import { StructuralMarkdownMiddleware } from '../src/middleware/agentic/structural-middleware.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { WorkspaceScanner } from '../src/cache/workspace.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { PROJECTS_DIR } from '../src/middleware/agentic/constants.js';

// Mock LLMExecutor to avoid actual API calls
vi.mock('../src/utils/LLMExecutor.js', () => {
    return {
        LLMExecutor: vi.fn().mockImplementation(function (this: any) {
            this.execute = vi.fn().mockImplementation(async (context: any) => {
                const userMsg = context.messages?.find((m: any) => m.role === 'user')?.content || '';
                const content = String(userMsg);

                if (content.includes('decomposition') || content.includes('Plan:')) {
                    return {
                        choices: [{
                            message: {
                                content: '## Plan\n- [ ] Task 1: Analyze logic\n- [ ] Task 2: Verify results'
                            }
                        }]
                    };
                }

                if (content.includes('Task 1')) {
                    return {
                        choices: [{
                            message: {
                                content: '## Result for Task 1\n**Decision:** Applied logic A.\n```file:src/logic.ts\nexport const logic = "A";\n```'
                            }
                        }]
                    };
                }

                return {
                    choices: [{
                        message: {
                            content: '## Final Result\n**Status:** Task completed.\n[RETRIEVED] src/logic.ts'
                        }
                    }]
                };
            });
            this.init = vi.fn().mockResolvedValue(undefined);
            this.persistStats = vi.fn().mockResolvedValue(undefined);
            this.calculateTokens = vi.fn().mockReturnValue(100);
            this.getTokenState = vi.fn().mockReturnValue({});
            this.getProviderStats = vi.fn().mockReturnValue({});
            this.recordProviderFailure = vi.fn();
            this.tryProvider = vi.fn().mockImplementation(async (context: any) => {
                return await this.execute(context.request);
            });
        })
    };
});

// Mock ProviderRegistry
vi.mock('../src/providers/registry.js', () => {
    return {
        ProviderRegistry: {
            getInstance: vi.fn().mockReturnValue({
                getAvailableProviders: vi.fn().mockReturnValue([{ 
                    id: 'gemini',
                    models: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 128000 }],
                    recordFailure: vi.fn(),
                    rateLimits: { rpm: 60, rpd: 1000 },
                    getUsageStats: vi.fn().mockReturnValue({ requestCountMinute: 0, requestCountDay: 0 }),
                    chat: vi.fn().mockImplementation(async (params: any) => {
                        console.error('[MOCK] Provider.chat called');
                        // Use the executor's logic
                        const { LLMExecutor } = await import('../src/utils/LLMExecutor.js');
                        const executor = new (LLMExecutor as any)();
                        return await executor.execute(params);
                    })
                }])
            })
        }
    };
});

// Mock instances.js to break circular dependency and use our mocked router
vi.mock('../src/pipeline/instances.js', () => {
    return {
        sharedRouter: {
            execute: async (context: any, next: any) => {
                const userMsg = context.request.messages.find((m: any) => m.role === 'user')?.content || '';
                const content = String(userMsg);
                
                if (content.includes('Analyze')) {
                    context.response = {
                        choices: [{
                            message: {
                                content: '## Analysis Result\n**Decision:** The current logic is O(n^2).\n[RETRIEVED] `src/logic.ts`'
                            }
                        }]
                    };
                } else if (content.includes('Implement')) {
                    context.response = {
                        choices: [{
                            message: {
                                content: '## Implementation Result\n**Decision:** Applied optimization A.\n```file:src/logic.ts\nexport const logic = "A";\n```\n- ✅ Task completed'
                            }
                        }]
                    };
                } else {
                    context.response = {
                        choices: [{
                            message: {
                                content: '## Verification Result\n**Status:** Verification passed.\n- ✅ All tests passed'
                            }
                        }]
                    };
                }
                return;
            }
        }
    };
});

describe('Agentic Memory End-to-End', () => {
    const TEST_SESSION = 'e2e-test-session-' + Date.now();
    const TEST_WORKSPACE = path.join(os.tmpdir(), 'free-llm-mcp-e2e-test');
    
    beforeAll(async () => {
        await fs.mkdir(TEST_WORKSPACE, { recursive: true });
        await fs.writeFile(path.join(TEST_WORKSPACE, 'README.md'), '# Test Project\nArchitecture overview.');
    });

    afterAll(async () => {
        await fs.rm(TEST_WORKSPACE, { recursive: true, force: true });
        const projectDir = path.join(PROJECTS_DIR, TEST_SESSION);
        await fs.rm(projectDir, { recursive: true, force: true });
    });

    it('should decompose tasks and harvest skills across multiple subtasks', async () => {
        const executor = new LLMExecutor();
        const pipeline = new PipelineExecutor();
        
        pipeline.use(new StructuralMarkdownMiddleware());
        pipeline.use(new AgenticMiddleware());
        
        const context: any = {
            sessionId: TEST_SESSION,
            agentic: true,
            wsHash: 'test-ws-hash',
            request: {
                messages: [
                    { 
                        role: 'user', 
                        content: '1. Analyze the current logic in src/logic.ts\n2. Implement optimization A\n3. Verify the changes' 
                    }
                ]
            }
        };

        // Execute pipeline
        await pipeline.execute(context);

        // Wait for debounced state persistence (2000ms)
        await new Promise(resolve => setTimeout(resolve, 2500));

        // Verify decomposition: should have run multiple times
        // The AgenticMiddleware loop will call the sharedRouter (which we mock indirectly by mocking LLMExecutor)
        
        // 1. Check if knowledge.md was harvested
        const projectDir = path.join(PROJECTS_DIR, TEST_SESSION);
        const knowledgePath = path.join(projectDir, 'knowledge.md');
        const knowledgeContent = await fs.readFile(knowledgePath, 'utf-8');

        expect(knowledgeContent).toContain('### Analysis Result');
        expect(knowledgeContent).toContain('**what:**');
        expect(knowledgeContent).toContain('- **Decision:** The current logic is O(n^2).');
        expect(knowledgeContent).toContain('**files:**');
        expect(knowledgeContent).toContain('- `src/logic.ts`');

        // 2. Check if state.json was updated and eventually cleared (or at least reflects completion)
        const statePath = path.join(projectDir, 'state.json');
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const state = JSON.parse(stateContent);
        
        // After completion of all tasks in the loop, nowQueue should be empty
        expect(state.nowQueue).toHaveLength(0);
    });

    it('should inject workspace context into the user message via StructuralMarkdownMiddleware', async () => {
        // Seed some existing memory (must be > 50 chars for extractMdContext and use colons in list items)
        const projectDir = path.join(PROJECTS_DIR, TEST_SESSION + '-context');
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, 'knowledge.md'), '### Existing Skill\n- what: Already knows X.\n- why: Because it was implemented in a previous turn and verified by the user.\n- files: `src/old.ts`');

        const middleware = new StructuralMarkdownMiddleware();
        const context: any = {
            request: {
                messages: [
                    { role: 'user', content: 'New query' }
                ],
                agentic: true
            },
            sessionId: TEST_SESSION + '-context',
            workspaceRoot: TEST_WORKSPACE
        };

        await middleware.execute(context, async () => {});

        const injectedContent = context.request.messages[0].content;
        expect(injectedContent).toContain('### SESSION DISTILLATION');
        expect(injectedContent).toContain('Already knows X');
        expect(injectedContent).toContain('New query');
        
        // Cleanup
        await fs.rm(projectDir, { recursive: true, force: true });
    });
});
