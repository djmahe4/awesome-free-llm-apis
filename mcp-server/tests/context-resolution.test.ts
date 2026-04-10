import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { resolveFileRefs, summarizeTextLocally } from '../src/tools/use-free-llm.js';

vi.mock('fs-extra', () => ({
    default: {
        pathExists: vi.fn(),
        stat: vi.fn(),
        readFile: vi.fn(),
    },
    pathExists: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
}));

describe('Context Resolution (v1.0.4) Unit Tests', () => {
    const mockWsRoot = '/mock/workspace';
    const mockAppDataRoot = path.join(os.homedir(), '.gemini', 'antigravity');

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('summarizeTextLocally', () => {
        it('should summarize a long text using word frequency', () => {
            const longText = 'Apple banana cherry apple banana apple. '.repeat(100);
            const summary = summarizeTextLocally(longText, 50);
            expect(summary).toContain('<!-- summarized -->');
            expect(summary.length).toBeLessThanOrEqual(100); // 50 limit + tag
        });

        it('should return original text if it is short', () => {
            const shortText = 'Short text set.';
            const summary = summarizeTextLocally(shortText, 100);
            expect(summary).toBe(shortText.substring(0, 100) + "... [truncated]");
        });
    });

    describe('resolveFileRefs', () => {
        it('should inline a file reference if it is within workspace boundaries', async () => {
            const targetFile = path.join(mockWsRoot, 'plan.md');
            const targetContent = '# My Plan\nContent here.';
            
            (fs.pathExists as any).mockResolvedValue(true);
            (fs.stat as any).mockResolvedValue({ isFile: () => true });
            (fs.readFile as any).mockResolvedValue(targetContent);

            const input = `Check [plan](file://${targetFile.replace(/\\/g, '/')})`;
            const result = await resolveFileRefs(input, [], mockWsRoot);

            expect(result).toContain('```file:plan.md');
            expect(result).toContain('# My Plan');
            expect(fs.readFile).toHaveBeenCalled();
        });

        it('should inline a file from Antigravity app data directory', async () => {
            const targetFile = path.join(mockAppDataRoot, 'brain', 'session', 'task.md');
            const targetContent = '- [ ] Task 1';

            (fs.pathExists as any).mockResolvedValue(true);
            (fs.stat as any).mockResolvedValue({ isFile: () => true });
            (fs.readFile as any).mockResolvedValue(targetContent);

            const input = `file://${targetFile.replace(/\\/g, '/')}`;
            const result = await resolveFileRefs(input, [], mockWsRoot);

            expect(result).toContain('```file:task.md');
            expect(result).toContain('Task 1');
        });

        it('should reject files outside allowed boundaries (Security Gate)', async () => {
            const outsideFile = '/etc/passwd';
            
            const input = `file://${outsideFile}`;
            const result = await resolveFileRefs(input, [], mockWsRoot);

            expect(result).toBe(input);
            expect(fs.readFile).not.toHaveBeenCalled();
        });

        it('should handle Windows style paths with file:/// prefix', async () => {
            const targetFile = 'C:\\Users\\test\\project\\file.txt';
            const wsRoot = 'C:\\Users\\test\\project';
            const targetContent = 'Windows content';

            (fs.pathExists as any).mockResolvedValue(true);
            (fs.stat as any).mockResolvedValue({ isFile: () => true });
            (fs.readFile as any).mockResolvedValue(targetContent);

            // Mock absolute path check for Windows in test environment
            // Since we're likely on Windows (per user info), we can use real path.resolve
            const input = `[file](file:///C:/Users/test/project/file.txt)`;
            const result = await resolveFileRefs(input, [], wsRoot);

            expect(result).toContain('```file:file.txt');
            expect(result).toContain(targetContent);
        });

        it('should summarize files that exceed the limit during inlining', async () => {
            const targetFile = path.join(mockWsRoot, 'large.log');
            const targetContent = 'Important line. '.repeat(2000); // ~32k chars

            (fs.pathExists as any).mockResolvedValue(true);
            (fs.stat as any).mockResolvedValue({ isFile: () => true });
            (fs.readFile as any).mockResolvedValue(targetContent);

            const input = `file://${targetFile.replace(/\\/g, '/')}`;
            const result = await resolveFileRefs(input, [], mockWsRoot);

            expect(result).toContain('<!-- summarized -->');
            expect(result.length).toBeLessThan(targetContent.length);
        });

        it('should reject resolution if workspaceRoot is an empty string (Security Hardening)', async () => {
            const input = 'file:///C:/etc/passwd';
            const wsRoot = ''; // Potentially dangerous if resolved to process.cwd()
            
            const result = await resolveFileRefs(input, [], wsRoot);
            
            expect(result).toBe(input);
            expect(fs.readFile).not.toHaveBeenCalled();
        });
    });
});
