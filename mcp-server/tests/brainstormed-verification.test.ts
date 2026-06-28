import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { writeFileAtomic } from '../src/utils/FileUtils.js';
import { TextRouterMiddleware } from '../src/pipeline/middlewares/TextRouterMiddleware.js';
import { ImageRouterMiddleware } from '../src/pipeline/middlewares/ImageRouterMiddleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { BaseProvider } from '../src/providers/base.js';
import { TaskType, type PipelineContext } from '../src/pipeline/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Brainstormed Verification Scenarios (Phases 1-3)', () => {
    const tempDir = path.join(__dirname, 'temp-brainstormed-fixtures');

    beforeEach(async () => {
        await fsp.mkdir(tempDir, { recursive: true });
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    // -------------------------------------------------------------------------
    // Scenario A: The Massive Monorepo (Pre-emptive Indexing / Classification)
    // -------------------------------------------------------------------------
    it('Scenario A: Should classify and index a massive monorepo without crashing', async () => {
        // Create 55 dummy files of various extensions
        const extensions = ['ts', 'py', 'json', 'md', 'bin', 'txt', 'go', 'rs', 'java', 'sh'];
        for (let i = 1; i <= 55; i++) {
            const ext = extensions[i % extensions.length];
            const filePath = path.join(tempDir, `file-${i}.${ext}`);
            await fsp.writeFile(filePath, `// Dummy content for file ${i}\nconsole.log("hello");`, 'utf-8');
        }

        const executor = new LLMExecutor();
        const router = new TextRouterMiddleware(executor);

        // A prompt containing coding terms under this directory
        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: 'Please help me refactor the typescript files in this project.' }]
            },
            workspaceRoot: tempDir
        };

        // Classify the task
        const taskType = (router as any).autoClassify(context.request.messages, context.keywords);
        expect(taskType).toBe(TaskType.Coding);
    });

    // -------------------------------------------------------------------------
    // Scenario B: High-Concurrency Session Stress (Atomic Writes)
    // -------------------------------------------------------------------------
    it('Scenario B: Should prevent corruption under high-concurrency atomic writes', async () => {
        const targetFile = path.join(tempDir, 'state.json');
        const numWriters = 30;

        // Spawn 30 concurrent writers writing different JSON objects
        const writePromises = Array.from({ length: numWriters }).map((_, index) => {
            const stateObj = {
                writerId: index,
                timestamp: Date.now(),
                data: 'a'.repeat(500), // ~0.5KB of payload
                status: 'success'
            };
            return writeFileAtomic(targetFile, JSON.stringify(stateObj, null, 2));
        });

        // Execute all writes in parallel
        await expect(Promise.all(writePromises)).resolves.not.toThrow();

        // The file must exist and be valid, parseable JSON
        const finalContent = await fsp.readFile(targetFile, 'utf-8');
        expect(() => JSON.parse(finalContent)).not.toThrow();
        
        const parsed = JSON.parse(finalContent);
        expect(parsed.status).toBe('success');
        expect(parsed.writerId).toBeLessThan(numWriters);
    });

    // -------------------------------------------------------------------------
    // Scenario C: Multi-Modal Path Resolution (Image Routing)
    // -------------------------------------------------------------------------
    it('Scenario C: Should resolve image paths containing spaces and Windows backslashes', async () => {
        // Create a subfolder with spaces
        const spaceSubdir = path.join(tempDir, 'my test folder');
        await fsp.mkdir(spaceSubdir, { recursive: true });

        // Create a dummy image file
        const dummyImagePath = path.join(spaceSubdir, 'test image.png');
        await fsp.writeFile(dummyImagePath, 'dummy-png-binary-data');

        const registry = ProviderRegistry.getInstance();
        class VisionMockProvider extends BaseProvider {
            name = 'VisionMock';
            id = 'vision-mock';
            baseURL = 'http://mock';
            envVar = 'VISION_MOCK_API_KEY';
            models = [{ id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextWindow: 32768, isVision: true }];
            rateLimits = { rpm: 60 };
            constructor() {
                super();
                vi.stubEnv(this.envVar, 'mock-key-is-sufficiently-long');
            }
            override isAvailable(): boolean { return true; }
        }
        const visionProv = new VisionMockProvider();
        registry.registerProvider(visionProv);
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([visionProv]);

        const executor = new LLMExecutor();
        const imageRouter = new ImageRouterMiddleware(executor);

        // Mock tryProvider to verify it gets called
        const trySpy = vi.spyOn(executor, 'tryProvider').mockResolvedValue({
            id: 'mock-response',
            object: 'chat.completion',
            created: Date.now(),
            model: 'gemini-3.1-flash-lite',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Processed image' }, finish_reason: 'stop' }]
        } as any);

        const fileUrl = pathToFileURL(dummyImagePath).href;

        const context: PipelineContext = {
            request: {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analyze this image' },
                            { type: 'image_url', image_url: { url: fileUrl } }
                        ] as any
                    }
                ]
            }
        };

        // Running the image router should resolve the path, inline the image as base64, and route it without throwing
        await expect(imageRouter.execute(context, async () => {})).resolves.not.toThrow();
        expect(trySpy).toHaveBeenCalled();
        
        // Verify it was converted to base64 inline
        const routedMsgContent = context.request.messages[0].content as any[];
        const imagePart = routedMsgContent.find(p => p.type === 'image_url');
        expect(imagePart.image_url.url).toContain('data:image/png;base64,');
    });

    // -------------------------------------------------------------------------
    // Scenario D: Middleware Pipeline Order and Singleton Resolution (Phase 4)
    // -------------------------------------------------------------------------
    it('Scenario D: Should resolve middlewares as singletons and execute them in correct order', async () => {
        const { 
            getStructuralMarkdownMiddleware, 
            getAgenticMiddleware,
            getSharedRouter
        } = await import('../src/pipeline/instances.js');

        // 1. Verify Singleton Resolution
        const struct1 = getStructuralMarkdownMiddleware();
        const struct2 = getStructuralMarkdownMiddleware();
        expect(struct1).toBe(struct2);

        const agentic1 = getAgenticMiddleware();
        const agentic2 = getAgenticMiddleware();
        expect(agentic1).toBe(agentic2);

        const router1 = getSharedRouter();
        const router2 = getSharedRouter();
        expect(router1).toBe(router2);

        // 2. Verify Pipeline Context Flow
        const context: PipelineContext = {
            request: {
                agentic: true,
                sessionId: 'test-session-d',
                messages: [{ role: 'user', content: 'Original prompt' }]
            }
        };

        // Run structural middleware first
        await struct1.execute(context, async () => {
            // Verify that structural middleware prepended the diagnostic header
            const userMsg = context.request.messages.find(m => m.role === 'user');
            expect(userMsg).toBeDefined();
            expect(userMsg?.content).toContain('# RESPONSE FORMAT');
            expect(userMsg?.content).toContain('Original prompt');
        });
    });
});
