import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RouterUpdater } from '../scripts/utils/router-updater.js';
import { TaskType } from '../src/pipeline/middleware.js';

describe('RouterUpdater', () => {
    const testFilePath = path.join(__dirname, 'test-router-middleware.ts');
    const mockContent = `
export class IntelligentRouterMiddleware {
    private static readonly modelCapabilities: Record<string, number> = {
        'model-a': 0.8,
        'model-b': 0.9,
    };

    public static taskRouteMap: Record<TaskType, string[]> = {
        [TaskType.Coding]: [
            'model-a',
            'model-b',
        ],
        [TaskType.Chat]: [
            'model-b',
        ],
    };
}

export class ImageRouterMiddleware {
    public static readonly imageModelCapabilities: Record<string, number> = {
        'vision-a': 0.7,
    };
}
`;

    beforeEach(async () => {
        await fs.writeFile(testFilePath, mockContent);
    });

    afterEach(async () => {
        try {
            await fs.unlink(testFilePath);
        } catch {}
    });

    it('should update a model capability score', async () => {
        const updater = new RouterUpdater(testFilePath);
        await updater.updateCapability('model-a', 0.95);
        
        const content = await fs.readFile(testFilePath, 'utf-8');
        expect(content).toContain("'model-a': 0.95");
        expect(content).not.toContain("'model-a': 0.8");
    });

    it('should update a vision model capability score', async () => {
        const updater = new RouterUpdater(testFilePath);
        await updater.updateCapability('vision-a', 0.85, true);
        
        const content = await fs.readFile(testFilePath, 'utf-8');
        expect(content).toContain("'vision-a': 0.85");
        expect(content).not.toContain("'vision-a': 0.7");
    });

    it('should add a model to a task route if not present', async () => {
        const updater = new RouterUpdater(testFilePath);
        await updater.addTaskModel(TaskType.Coding, 'model-c');
        
        const content = await fs.readFile(testFilePath, 'utf-8');
        expect(content).toContain("'model-c'");
        // Simple check to see if it's in the Coding list
        // In a real scenario, we'd use regex to be more precise about the list
    });

    it('should remove a model from a task route', async () => {
        const updater = new RouterUpdater(testFilePath);
        await updater.removeTaskModel(TaskType.Coding, 'model-a');
        
        const content = await fs.readFile(testFilePath, 'utf-8');
        // Check that model-a is still in capabilities but gone from Coding route
        expect(content).toContain("'model-a': 0.8");
        
        // This regex checks if model-a is still in the Coding list
        const codingRegex = /\[TaskType\.Coding\]\s*:\s*\[[\s\S]*?\]/;
        const codingBlock = content.match(codingRegex)?.[0];
        expect(codingBlock).not.toContain("'model-a'");
    });
});
