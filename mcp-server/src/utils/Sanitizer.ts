/**
 * Sanitizer utility to clean sensitive data from strings before indexing or logging.
 */
export class Sanitizer {
    private static readonly SENSITIVE_PATTERNS = [
        // API Keys and Tokens (refined to avoid redacting function calls like os.getenv)
        /(?:api[_-]?key|token|auth[_-]?key|access[_-]?key|secret|password|passwd|pwd|private[_-]?key)(?:\s*[:=]\s*|\s+)(?:['"]?)([a-zA-Z0-9\-._]{8,})(?![a-zA-Z0-9\-._])(?!\()(?:['"]?)/gi,
        // Generic high-entropy strings that look like keys (e.g. base64 or hex > 32 chars)
        /\b[a-fA-F0-9]{32,}\b/g,
        // Base64 regex ensuring we do not match image data URIs (must be boundary-anchored or standalone)
        /\b(?!data:image\/)[a-zA-Z0-9+/]{40,}={0,2}\b/g,
        // URLs with embedded credentials
        /https?:\/\/[^/:]+:[^/@]+@/g,
        // Common environment variable patterns (refined to avoid redacting function calls)
        /(?:SET|EXPORT)\s+(?:[A-Z_]+)\s*=\s*(?:['"]?)([a-zA-Z0-9\-._]{8,})(?![a-zA-Z0-9\-._])(?!\()(?:['"]?)/gi,
        // Email addresses
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        // Phone numbers (international + domestic)
        /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{4}\b/g,
        // Credit cards (13-19 digits with optional separators)
        /\b(?:\d[ -]*?){13,19}\b/g,
        // Bearer / JWT style secrets
        /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi,
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    ];

    /**
     * Sanitizes a string by replacing sensitive patterns with a placeholder.
     */
    static sanitize(text: string): string {
        if (!text) return text;
        
        // Dynamic bypass for image data URLs to prevent base64 payload corruption
        if (text.startsWith('data:image/')) {
            return text;
        }
        
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
