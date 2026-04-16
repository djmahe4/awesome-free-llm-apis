import { describe, it, expect } from 'vitest';
import { summarizeTextLocally } from '../src/tools/use-free-llm.js';

describe('Summarization Effectiveness (v1.0.4)', () => {
    
    it('should prioritize sentences with high-frequency "long" words', () => {
        const text = `
            This is a rare sentence with unique content.
            The word "elephant" is very frequent in this elephant-themed text about elephants.
            Small words are ignored by the algorithm.
            Elephants are large and gray and elephants live in Africa.
            Common noise that should be ranked lower because it contains fewer high-frequency words.
        `;
        // "elephant" appears 5 times (elephant, elephant-themed, elephants, Elephants, elephants)
        // sentences with "elephant" should score higher.
        
        const summary = summarizeTextLocally(text, 200);
        
        expect(summary).toContain('elephant');
        expect(summary).toContain('Elephants are large');
        // It should rank the elephant sentences first because they have the most frequent word
    });

    it('should strictly enforce the character limit', () => {
        const text = 'Sentence one. Sentence two. Sentence three. Sentence four. Sentence five. '.repeat(100);
        const limit = 100;
        const summary = summarizeTextLocally(text, limit);
        
        expect(summary.length).toBeLessThanOrEqual(limit + 25); // Accommodate the tag
        expect(summary).toContain('<!-- summarized -->');
    });

    it('should properly score by word density (score / wordCount)', () => {
        const text = `
            Keyword Keyword Keyword Keyword Keyword.
            A very long sentence that has the Keyword only once but many other words that are not Keywords.
            Small.
            Small again.
            Small three.
        `;
        // The first sentence has 100% density of the keyword.
        // The second has low density.
        
        const summary = summarizeTextLocally(text, 150);
        
        const lines = summary.split('\n');
        // The first sentence should definitely be in there
        expect(lines[1]).toContain('Keyword');
    });

    it('should handle the "short file" cliff correctly (truncation vs scoring)', () => {
        const fourSentences = 'One two three four five six seven eight nine ten. '.repeat(4);
        const fiveSentences = 'One two three four five six seven eight nine ten. '.repeat(5);
        
        const summary4 = summarizeTextLocally(fourSentences, 50);
        const summary5 = summarizeTextLocally(fiveSentences, 50);
        
        // 4 sentences should use simple truncation
        expect(summary4).toContain('[truncated]');
        // 5 sentences should use TF scoring
        expect(summary5).toContain('<!-- summarized -->');
    });

    it('should handle text with no punctuation or newlines gracefully', () => {
        const text = 'word '.repeat(1000); // One giant sentence
        const summary = summarizeTextLocally(text, 100);
        
        // Since there is only 1 "sentence" (no split), it should fall into the < 5 sentences case
        expect(summary).toContain('[truncated]');
    });

    it('should pick different sentences if multiple exist (no deduplication currently)', () => {
        const text = `
            Important information about the project.
            Important information about the project.
            Important information about the project.
            Important information about the project.
            Important information about the project.
        `;
        const summary = summarizeTextLocally(text, 200);
        
        const occurrences = summary.split('Important').length - 1;
        expect(occurrences).toBeGreaterThan(1);
    });
});
