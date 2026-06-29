import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import fs from 'fs-extra';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { PipelineContext } from '../src/pipeline/middleware.js';
import { TaskType } from '../src/pipeline/middleware.js';

describe('TDD Scenario A - The Massive Monorepo (Pre-emptive Indexing)', () => {
    const testRepoDir = path.resolve('./tests/temp-massive-monorepo');

    beforeAll(async () => {
        await fs.mkdirp(testRepoDir);

        // Generate 50+ mock files of varying extensions to simulate a large monorepo
        const extensions = ['ts', 'py', 'json', 'md', 'go', 'rs', 'js', 'bin', 'txt', 'yml'];
        const directories = ['src', 'lib', 'tests', 'config', 'bin', 'docs', 'packages/api/src', 'packages/web/src'];

        for (const dir of directories) {
            await fs.mkdirp(path.join(testRepoDir, dir));
        }

        for (let i = 0; i < 60; i++) {
            const ext = extensions[i % extensions.length];
            const dir = directories[i % directories.length];
            const fileName = `file-${i}.${ext}`;
            const filePath = path.join(testRepoDir, dir, fileName);

            if (ext === 'bin') {
                await fs.writeFile(filePath, Buffer.alloc(1024)); // Binary file
            } else if (ext === 'json') {
                await fs.writeJson(filePath, { index: i, type: 'mock' });
            } else {
                await fs.writeFile(filePath, `// Mock content for file ${i}\nconsole.log("hello world");`);
            }
        }
    });

    afterAll(async () => {
        try {
            await fs.remove(testRepoDir);
        } catch {}
    });

    it('should classify a coding task correctly in a massive monorepo without crashing', async () => {
        const router = new IntelligentRouterMiddleware();
        
        const context: PipelineContext = {
            request: {
                model: 'any',
                messages: [
                    { role: 'user', content: 'Please refactor the code in src/file-0.ts to use async/await.' }
                ]
            },
            workspaceRoot: testRepoDir
        };

        // Run the router's execute method (it will classify the task)
        // We mock next() to verify the taskType after classification
        const nextMock = async () => {};

        // Since we are not providing API keys, the router will fail to find providers
        // but we want to verify that the classification step completes successfully before that
        try {
            await router.execute(context, nextMock);
        } catch (err: any) {
            // We expect it to either pass or throw "No available providers"
            // but it must NOT throw path resolution or OOM errors
            expect(err.message).toContain('No available providers');
        }

        // Verify task was classified as Coding
        expect(context.taskType).toBe(TaskType.Coding);
    });

    it('should classify a general chat task correctly in a massive monorepo', async () => {
        const router = new IntelligentRouterMiddleware();
        
        const context: PipelineContext = {
            request: {
                model: 'any',
                messages: [
                    { role: 'user', content: 'How do I configure git?' }
                ]
            },
            workspaceRoot: testRepoDir
        };

        const nextMock = async () => {};

        try {
            await router.execute(context, nextMock);
        } catch (err: any) {
            expect(err.message).toContain('No available providers');
        }

        // Should fall back to Chat (or at least not be Coding since it is general Git help)
        expect(context.taskType).toBe(TaskType.Chat);
    });
});
