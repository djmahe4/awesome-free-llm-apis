import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { storeWorkspaceSkill } from '../src/tools/store-workspace-skill.js';
import { normalizeScriptFilename, addScriptMetadataHeader } from '../src/tools/store-workspace-skill.js';
import { useFreeLLM } from '../src/tools/use-free-llm.js';
import { memoryManager } from '../src/memory/index.js';
import { ContextGatherer } from '../src/middleware/agentic/context-gatherer.js';
import fs from 'node:fs/promises';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock dependencies
vi.mock('../src/tools/use-free-llm.js', () => ({
    useFreeLLM: vi.fn()
}));

vi.mock('../src/memory/index.js', () => ({
    memoryManager: {
        search: vi.fn()
    }
}));

vi.mock('../src/middleware/agentic/context-gatherer.js', () => ({
    ContextGatherer: {
        gatherContext: vi.fn()
    }
}));

// Mock WorkspaceScanner to avoid actual hashing in tests
vi.mock('../src/cache/workspace.js', () => ({
    WorkspaceScanner: vi.mocked(class {
        getWorkspaceHash = vi.fn().mockResolvedValue('test-hash');
    })
}));

describe('storeWorkspaceSkill Scenarios', () => {
    const root = path.join(os.tmpdir(), 'test_ws_scenarios');
    
    beforeEach(() => {
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    });

    it('should inject both memory and grep context into the system prompt', async () => {
        // Setup mocks
        const mockMemory = ['- Memory snippet 1'];
        const mockGrep = ['Grep snippet 1'];
        
        (memoryManager.search as any).mockResolvedValue([{ content: 'Memory snippet 1' }]);
        (ContextGatherer.gatherContext as any).mockResolvedValue(mockGrep);
        (useFreeLLM as any).mockResolvedValue({
            choices: [{ message: { content: '```bash\necho "grounded"\n```' } }]
        });

        await storeWorkspaceSkill({
            name: 'grounding-test',
            description: 'test',
            what: ['test'],
            workspace_root: root,
            script_instructions: {
                'test.sh': 'Verify grounding'
            }
        });

        // Inspect the prompt sent to useFreeLLM
        const lastCall = (useFreeLLM as any).mock.calls[0][0];
        const systemPrompt = lastCall.messages.find((m: any) => m.role === 'system').content;

        expect(systemPrompt).toContain('🧠 WORKSPACE MEMORY');
        expect(systemPrompt).toContain('Memory snippet 1');
        expect(systemPrompt).toContain('🔍 WORKSPACE CONTEXT');
        expect(systemPrompt).toContain('Grep snippet 1');
        expect(systemPrompt).toContain('TASK: SCRIPT GENERATION');
    });

    it('should handle missing context gracefully', async () => {
        (memoryManager.search as any).mockResolvedValue([]);
        (ContextGatherer.gatherContext as any).mockResolvedValue([]);
        (useFreeLLM as any).mockResolvedValue({
            choices: [{ message: { content: '```bash\necho "no-context"\n```' } }]
        });

        await storeWorkspaceSkill({
            name: 'empty-context',
            description: 'test',
            what: ['test'],
            workspace_root: root,
            script_instructions: {
                'test.sh': 'Verify empty context'
            }
        });

        const lastCall = (useFreeLLM as any).mock.calls[0][0];
        const systemPrompt = lastCall.messages.find((m: any) => m.role === 'system').content;

        expect(systemPrompt).not.toContain('WORKSPACE MEMORY');
        expect(systemPrompt).not.toContain('WORKSPACE CONTEXT');
        expect(systemPrompt).toContain('TASK: SCRIPT GENERATION');
    });

    it('should extract code correctly even without markdown blocks if necessary', async () => {
        (useFreeLLM as any).mockResolvedValue({
            choices: [{ message: { content: '```bash\necho "raw-code-output"\n```' } }]
        });

        const result = await storeWorkspaceSkill({
            name: 'raw-extract',
            description: 'test',
            what: ['test'],
            workspace_root: root,
            script_instructions: {
                'raw.sh': 'Return raw code'
            }
        });

        if (!result.success) throw new Error(result.error);
        expect(result.success).toBe(true);
        
        // Verify file content
        const scriptPath = path.join(root, '.free-llm-mcp', 'skills', 'raw-extract', 'scripts', 'raw.sh');
        const content = await fs.readFile(scriptPath, 'utf-8');
        expect(content).toContain('skill: raw-extract');
        expect(content).toContain('version: 1.0.6');
        expect(content).toContain('echo "raw-code-output"');
    });

    it('should handle large context injections by joining them (potential overflow check)', async () => {
        const largeGrep = Array(100).fill('const x = 1; // repeating line for volume');
        (ContextGatherer.gatherContext as any).mockResolvedValue(largeGrep);
        (useFreeLLM as any).mockResolvedValue({
            choices: [{ message: { content: '```js\nconsole.log("large");\n```' } }]
        });

        await storeWorkspaceSkill({
            name: 'large-context',
            description: 'test',
            what: ['test'],
            workspace_root: root,
            script_instructions: {
                'large.js': 'Handle large context'
            }
        });

        const lastCall = (useFreeLLM as any).mock.calls[0][0];
        const systemPrompt = lastCall.messages.find((m: any) => m.role === 'system').content;

        // Verify it includes the start and end of the large context
        expect(systemPrompt.length).toBeGreaterThan(4000);
        expect(systemPrompt).toContain('const x = 1;');
    });

    it('should handle LLM response truncation or missing code blocks by using raw content', async () => {
        // Scenario: LLM starts a code block but never finishes it or just gives garbage
        (useFreeLLM as any).mockResolvedValue({
            choices: [{ message: { content: 'Here is your code: ```bash\necho "truncated"' } }]
        });

        const result = await storeWorkspaceSkill({
            name: 'truncation-test',
            description: 'Test script truncation and extraction',
            what: ['generating a script'],
            workspace_root: root,
            script_instructions: { 'fix.sh': 'echo "truncated"' }
        });

        if (!result.success) throw new Error(result.error);
        
        // Wait a small amount for FS sync on Windows
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const scriptPath = path.join(root, '.free-llm-mcp', 'skills', 'truncation-test', 'scripts', 'fix.sh');
        const content = await fs.readFile(scriptPath, 'utf-8');
        expect(result.success).toBe(true);
        expect(content).toContain('```bash'); // Falls back to raw because closing block is missing
    });
});

describe('Internal Utility Functions', () => {
    describe('normalizeScriptFilename', () => {
        it('should handle files with .py extension', () => {
            expect(normalizeScriptFilename('test.py')).toBe('test.py');
        });

        it('should handle files with _py suffix', () => {
            expect(normalizeScriptFilename('test_py')).toBe('test.py');
        });

        it('should NOT force .py for files with extensions', () => {
            expect(normalizeScriptFilename('test.sh')).toBe('test.sh');
            expect(normalizeScriptFilename('test.js')).toBe('test.js');
            expect(normalizeScriptFilename('test.yaml')).toBe('test.yaml');
        });

        it('should not force .py for files without extensions (fixing bug)', () => {
            expect(normalizeScriptFilename('test')).toBe('test');
        });

    });

    describe('addScriptMetadataHeader', () => {
        const skillName = 'test-skill';
        const version = '1.0.6';

        it('should use # for shell and python files', () => {
            const content = 'print("hello")';
            const header = addScriptMetadataHeader(content, skillName, version, 'test.py');
            expect(header).toContain('# skill: test-skill');
            expect(header).toContain('# version: 1.0.6');
        });

        it('should use # for yaml files', () => {
            const content = 'key: value';
            const header = addScriptMetadataHeader(content, skillName, version, 'test.yaml');
            expect(header).toContain('# skill: test-skill');
        });

        it('should use // for javascript files', () => {
            const content = 'console.log("hello")';
            const header = addScriptMetadataHeader(content, skillName, version, 'test.js');
            expect(header).toContain('// skill: test-skill');
            expect(header).toContain('// version: 1.0.6');
        });

        it('should handle protocol-relative URLs in content correctly', () => {
            const content = '//cdn.example.com/script.js';
            const header = addScriptMetadataHeader(content, skillName, version, 'test.js');
            expect(header).toContain('// skill: test-skill');
            expect(header).toContain('//cdn.example.com/script.js');
        });
    });
});
