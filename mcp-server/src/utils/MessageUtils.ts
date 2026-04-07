import type { Message } from '../providers/types.js';

/**
 * Safely extracts text content from a Message, handling both string and multi-modal (array) content.
 */
export function getMessageContent(message: Message): string {
    if (!message || message.content === undefined || message.content === null) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        const contentArray = message.content as any[];
        return contentArray
            .map((part: any) => (typeof part === 'string' ? part : (part.text || '')))
            .join(' ');
    }
    return String(message.content);
}
