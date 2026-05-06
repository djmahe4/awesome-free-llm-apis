/**
 * Sanitizer utility to clean sensitive data from strings before indexing or logging.
 */
export class Sanitizer {
    private static readonly SENSITIVE_PATTERNS = [
        // API Keys and Tokens
        /(?:api[_-]?key|token|auth[_-]?key|access[_-]?key|secret|password|passwd|pwd|private[_-]?key)(?:\s*[:=]\s*|\s+)(?:['"]?)([a-zA-Z0-9\-._]{8,})(?:['"]?)/gi,
        // Generic high-entropy strings that look like keys (e.g. base64 or hex > 32 chars)
        /[a-fA-F0-9]{32,}/g,
        /[a-zA-Z0-9+/]{40,}={0,2}/g,
        // URLs with embedded credentials
        /https?:\/\/[^/:]+:[^/@]+@/g,
        // Common environment variable patterns
        /(?:SET|EXPORT)\s+(?:[A-Z_]+)\s*=\s*(?:['"]?)([a-zA-Z0-9\-._]{8,})(?:['"]?)/gi,
    ];

    /**
     * Sanitizes a string by replacing sensitive patterns with a placeholder.
     */
    static sanitize(text: string): string {
        if (!text) return text;
        
        let sanitized = text;
        for (const pattern of this.SENSITIVE_PATTERNS) {
            sanitized = sanitized.replace(pattern, (match, p1) => {
                // If there's a capture group (the actual key), redact it
                if (p1) {
                    return match.replace(p1, '[REDACTED]');
                }
                // Otherwise redact the whole match if it's a generic hex/base64 blob
                return '[REDACTED]';
            });
        }
        
        return sanitized;
    }

    /**
     * Sanitizes an object by recursively walking its properties.
     */
    static sanitizeObject(obj: any): any {
        if (obj === null || typeof obj !== 'object') {
            if (typeof obj === 'string') return this.sanitize(obj);
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.sanitizeObject(item));
        }

        const sanitized: any = {};
        for (const [key, value] of Object.entries(obj)) {
            // Check if key itself looks sensitive
            const isSensitiveKey = /(?:key|token|secret|password|auth|private)/i.test(key);
            
            if (isSensitiveKey && typeof value === 'string') {
                sanitized[key] = '[REDACTED]';
            } else {
                sanitized[key] = this.sanitizeObject(value);
            }
        }
        
        return sanitized;
    }
}
