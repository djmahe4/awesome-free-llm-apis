import type { Message } from '../providers/types.js';

/**
 * Safely extracts text content from a Message, handling both string and multi-modal (array) content.
 */
export function getMessageContent(message: Message): string {
    if (!message || message.content === undefined || message.content === null) return '';
    
    // 1. String content
    if (typeof message.content === 'string') return message.content;
    
    // 2. Array-based multi-modal content
    if (Array.isArray(message.content)) {
        const contentArray = message.content as any[];
        return contentArray
            .map((part: any) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') {
                    return part.text || part.task || part.content || '';
                }
                return String(part);
            })
            .filter(Boolean)
            .join(' ');
    }
    
    // 3. Single-object content (some models/parsers return this)
    if (typeof message.content === 'object' && message.content !== null) {
        const obj = message.content as any;
        return obj.text || obj.task || obj.content || String(obj);
    }
    
    return String(message.content);
}
