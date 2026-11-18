import { describe, it, expect } from 'vitest';
import { normalizeConversationTurns } from '../src/utils/MessageUtils.js';
import type { Message } from '../src/providers/types.js';

describe('normalizeConversationTurns', () => {
    it('handles empty messages', () => {
        expect(normalizeConversationTurns([])).toEqual([]);
    });

    it('appends user prompt if input contains only system messages', () => {
        const msgs: Message[] = [{ role: 'system', content: 'system context' }];
        const normalized = normalizeConversationTurns(msgs);
        expect(normalized.length).toBe(2);
        expect(normalized[0].role).toBe('system');
        expect(normalized[1].role).toBe('user');
    });

    it('merges consecutive messages of the same role', () => {
        const msgs: Message[] = [
            { role: 'system', content: 'system context' },
            { role: 'user', content: 'First query' },
            { role: 'assistant', content: 'First response' },
            { role: 'assistant', content: 'Second response' },
        ];
        const normalized = normalizeConversationTurns(msgs);
        // Should merge consecutive assistants and append trailing user message
        expect(normalized[0].role).toBe('system');
        expect(normalized[1].role).toBe('user');
        expect(normalized[1].content).toBe('First query');
        expect(normalized[2].role).toBe('assistant');
        expect(normalized[2].content).toContain('First response');
        expect(normalized[2].content).toContain('Second response');
        expect(normalized[3].role).toBe('user');
    });

    it('leaves already-alternating conversation ending with user untouched except copying', () => {
        const msgs: Message[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'query 1' },
            { role: 'assistant', content: 'answer 1' },
            { role: 'user', content: 'query 2' },
        ];
        const normalized = normalizeConversationTurns(msgs);
        expect(normalized.length).toBe(4);
        expect(normalized.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    });
});
