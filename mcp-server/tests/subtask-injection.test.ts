import { describe, it, expect, vi } from 'vitest';
import { decomposeGoal } from '../src/pipeline/middlewares/AgenticMiddleware.js';
import { AgenticMiddleware } from '../src/pipeline/middlewares/AgenticMiddleware.js';
import type { PipelineContext } from '../src/pipeline/middleware.js';
import fs from 'fs-extra';
import path from 'path';

describe('decomposeGoal Subtask List Parsing Tests', () => {
    it('parses numbered list "1. step" into array', () => {
        const goal = `
Here is my plan:
1. First step to verify files
2. Second step to execute tests
        `.trim();
        const steps = decomposeGoal(goal);
        expect(steps).toEqual([
            'First step to verify files',
            'Second step to execute tests'
        ]);
    });

    it('parses bulleted list "- step" into array', () => {
        const goal = `
Please do:
- Read package.json
- Upgrade vitest version
        `.trim();
        const steps = decomposeGoal(goal);
        expect(steps).toEqual([
            'Read and inspect package.json',
            'Upgrade vitest version'
        ]);
    });

    it('parses "* step" bullets', () => {
        const goal = `
* Compile the code base
* Run verification scripts
        `.trim();
        const steps = decomposeGoal(goal);
        expect(steps).toEqual([
            'Compile the code base',
            'Run verification scripts'
        ]);
    });

    it('falls back to newline-split for plain prose', () => {
        const goal = `
Line one description
Line two description
        `.trim();
        const steps = decomposeGoal(goal);
        expect(steps).toEqual([
            'Line one description',
            'Line two description'
        ]);
    });

    it('semantically combines consecutive read file steps', () => {
        const goal = `
1. Read package.json
2. Read vitest.config.ts
3. Implement a new route in server.ts
        `.trim();
        const steps = decomposeGoal(goal);
        expect(steps).toEqual([
            'Read and inspect package.json, vitest.config.ts',
            'Implement a new route in server.ts'
        ]);
    });

    it('proactively injects file content context before router execution for simple read subtask', async () => {
        const middleware = new AgenticMiddleware();
        const testFile = path.join(process.cwd(), 'temp-read-test.json');
        await fs.writeJson(testFile, { test: 'hello-proactive-context' });

        const context: PipelineContext = {
            request: {
                messages: [{ role: 'user', content: `Read ${testFile}` }]
            },
            agentic: true,
            sessionId: 'test-proactive-read-session',
            wsHash: 'dummy-hash'
        } as any;

        const instances = await import('../src/pipeline/instances.js');
        const routerSpy = vi.spyOn(instances.sharedRouter, 'execute');

        try {
            await middleware.execute(context, async () => {});
            expect(routerSpy).not.toHaveBeenCalled();
            const responseContent = context.response?.choices?.[0]?.message?.content;
            expect(responseContent).toContain('hello-proactive-context');
        } finally {
            await fs.remove(testFile);
            vi.restoreAllMocks();
        }
    });
});
