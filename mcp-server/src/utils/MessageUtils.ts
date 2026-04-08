import type { Message } from '../providers/types.js';

/**
 * Safely extracts text content from a Message, handling both string and multi-modal (array) content.
 */
/**
 * Safely extracts text content from a Message or raw content, handling strings, multi-modal (array) content, and structured objects.
 */
export function getMessageContent(input: any): string {
    if (input === undefined || input === null) return '';

    // Handle full Message object
    let content = input;
    if (typeof input === 'object' && 'content' in input && input.content !== undefined) {
        content = input.content;
    }

    if (content === undefined || content === null) return '';
    
    // 1. String content
    if (typeof content === 'string') return content;
    
    // 2. Array-based multi-modal content
    if (Array.isArray(content)) {
        return content
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
    if (typeof content === 'object') {
        return content.text || content.task || content.content || JSON.stringify(content);
    }
    
    return String(content);
}
