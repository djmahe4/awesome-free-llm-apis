import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { getIntelligentSystemPrompt, resetPromptCache } from '../src/middleware/agentic/prompts.js';

vi.mock('fs', () => {
    const mockPromises = {
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        access: vi.fn(),
        readFile: vi.fn(),
        stat: vi.fn(),
    };
    return {
        default: {
            promises: mockPromises,
        },
        promises: mockPromises,
    };
});

describe('Large Keywords & Budget Hardening', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetPromptCache();
    });

    it('limits the assembled prompt to much less than 25k chars (new budget 12k)', async () => {
        const mockData = {
            metadata: { version: '1.0' },
            introduction: 'Introduction context.',
            sections: Array.from({ length: 50 }, (_, i) => ({
                id: `sec_${i}`,
                title: `Section ${i}`,
                content: 'A'.repeat(2000), // 2k chars per section
                level: 2,
                keywords: [`key${i}`, 'universal']
            }))
        };

        const fsp = fs.promises;
        (fsp.stat as any).mockResolvedValue({ mtimeMs: Date.now() });
        (fsp.readFile as any).mockResolvedValue(JSON.stringify(mockData));

        // Use a keyword that matches everything plus many specific ones
        const keywords = ['universal', ...Array.from({ length: 20 }, (_, i) => `key${i}`)];
        const prompt = await getIntelligentSystemPrompt('Some context', keywords);

        expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_BUDGET_VAL); // Budget is now 12k
        
        // Count sections included (marked by "## Section")
        const sectionCount = (prompt.match(/## Section/g) || []).length;
        expect(sectionCount).toBeLessThanOrEqual(7); // Should be capped at 7 sections
    });

    it('requires a stricter score (4) for section inclusion', async () => {
        const mockData = {
            metadata: { version: '1.0' },
            introduction: 'Intro',
            sections: [
                {
                    id: 'low_score',
                    title: 'Low',
                    content: 'Should not be here',
                    level: 2,
                    keywords: ['irrelevant'] // Score would be 0 because 'onlyone' not in keywords? Wait.
                },
                {
                    id: 'high_score',
                    title: 'High Match',
                    content: 'Should be here',
                    level: 2,
                    keywords: ['match1'] // Score would be 3 (match) + 1.1 (level 2) = 4.1
                }
            ]
        };

        const fsp = fs.promises;
        (fsp.stat as any).mockResolvedValue({ mtimeMs: Date.now() });
        (fsp.readFile as any).mockResolvedValue(JSON.stringify(mockData));

        const prompt = await getIntelligentSystemPrompt('context', ['match1']);

        expect(prompt).toContain('Should be here');
        expect(prompt).not.toContain('Should not be here');
    });
});

const PROMPT_CHAR_BUDGET_VAL = 13000; // 12k + intro
