import { getEncoding } from 'js-tiktoken';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';

export class TokenManagerMiddleware implements Middleware {
    name = 'TokenManagerMiddleware';

    // Track remaining tokens per provider
    private tokenTracking: Record<string, { remainingTokens?: number; refreshTime?: number }> = {};

    // Use generic o200k_base or cl100k_base for fast estimation
    private encoder = getEncoding('cl100k_base');

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        if (!context.providerId) {
            return next();
        }

        const providerId = context.providerId;

        // 1. Local Token Calculation
        let estimatedTokens = 0;
        for (const msg of context.request.messages) {
            estimatedTokens += this.encoder.encode(msg.content).length;
        }
        const maxTokens = context.request.max_tokens || 1024;
        const totalEstimated = estimatedTokens + maxTokens;

        context.estimatedTokens = estimatedTokens;

        // 2. Proactive Deduction / Blocking
        const tracker = this.tokenTracking[providerId];
        if (tracker && tracker.remainingTokens !== undefined) {
            if (tracker.remainingTokens < totalEstimated) {
                throw new Error(`[TokenManager] Exceeded tracked tokens for ${providerId}. Requires ${totalEstimated}, remaining ${tracker.remainingTokens}`);
            }
            tracker.remainingTokens -= totalEstimated;
        }

        // 3. Await Next Middleware (LLM Call)
        await next();

        // 4. Drift Correction via Headers
        if (context.response && context.response._headers) {
            const headers = context.response._headers;

            // Look for standard rate limit headers across various providers
            const remainingTokensStr =
                headers['x-ratelimit-remaining-tokens'] ||
                headers['x-ratelimit-remaining-tokens-minute'] ||
                headers['x-ratelimit-tokens-remaining'];

            const resetTimeStr =
                headers['x-ratelimit-reset-tokens'] ||
                headers['x-ratelimit-reset-requests'];

            if (remainingTokensStr) {
                const remaining = parseInt(remainingTokensStr, 10);
                if (!isNaN(remaining)) {
                    this.tokenTracking[providerId] = this.tokenTracking[providerId] || {};
                    this.tokenTracking[providerId].remainingTokens = remaining;

                    if (resetTimeStr) {
                        // Assume seconds for reset time if it's purely a number
                        const resetVal = parseFloat(resetTimeStr);
                        if (!isNaN(resetVal)) {
                            this.tokenTracking[providerId].refreshTime = Date.now() + (resetVal * 1000);
                        }
                    }
                }
            }
        }
    }

    getTrackingState() {
        return this.tokenTracking;
    }
}
