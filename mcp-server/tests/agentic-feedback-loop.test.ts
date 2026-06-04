import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { AgenticMiddleware } from '../src/middleware/agentic/agentic-middleware.js';
import { ContextGatherer } from '../src/middleware/agentic/context-gatherer.js';

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
});
