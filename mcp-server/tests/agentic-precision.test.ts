import { describe, it, expect } from 'vitest';
import { getIntelligentSystemPrompt } from '../src/middleware/agentic/prompts.js';

describe('Agentic Precision Tests', () => {
    it('Broad keywords should not explode reference sections', async () => {
        // Context with broad architectural keywords
        const context = "You are a senior software architect reviewing python and rust code.";

        const prompt = await getIntelligentSystemPrompt(context);

        // It should not contain LangGraph or Phoenix links if they weren't explicitly matched
        const hasLangGraph = prompt.includes('LangGraph');
        const hasPhoenix = prompt.includes('Phoenix');

        console.log('Prompt contains LangGraph:', hasLangGraph);
        console.log('Prompt contains Phoenix:', hasPhoenix);

        // With the new thresholds (minEntryScore = 2.5 for sections < 12 score), 
        // these should be filtered out unless "graph" or "phoenix" was in the context.
        expect(hasLangGraph).toBe(false);
        expect(hasPhoenix).toBe(false);
    });

    it('Explicit subtask flag should suppress broad references', async () => {
        const context = "Implementing enum transformation in python";

        // Normal prompt might include some references if keywords match
        const normalPrompt = await getIntelligentSystemPrompt(context, [], undefined, false);

        // Subtask prompt should be leaner
        const subtaskPrompt = await getIntelligentSystemPrompt(context, [], undefined, true);

        console.log('Normal prompt length:', normalPrompt.length);
        console.log('Subtask prompt length:', subtaskPrompt.length);

        expect(subtaskPrompt.length).toBeLessThanOrEqual(normalPrompt.length);
    });
});
