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

    it('preserves multi-modal array content when merging consecutive same-role turns', () => {
        const msgs: Message[] = [
            { role: 'user', content: [{ type: 'text', text: 'Analyze this image:' }] },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
        ];
        const normalized = normalizeConversationTurns(msgs);
        expect(normalized.length).toBe(1);
        expect(Array.isArray(normalized[0].content)).toBe(true);
        expect(normalized[0].content.length).toBe(2);
        expect(normalized[0].content[0].type).toBe('text');
        expect(normalized[0].content[1].type).toBe('image_url');
    });

    it('respects ensureUserTerminal: false for assistant-prefill or few-shot completions', () => {
        const msgs: Message[] = [
            { role: 'user', content: 'Translate to French: Hello' },
            { role: 'assistant', content: 'Bonjour' },
        ];
        const normalized = normalizeConversationTurns(msgs, { ensureUserTerminal: false });
        expect(normalized.length).toBe(2);
        expect(normalized[normalized.length - 1].role).toBe('assistant');
        expect(normalized[normalized.length - 1].content).toBe('Bonjour');
    });
});
