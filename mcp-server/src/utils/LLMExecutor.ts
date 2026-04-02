import { getEncoding } from 'js-tiktoken';
import { ProviderRegistry } from '../providers/registry.js';
import type { PipelineContext } from '../pipeline/middleware.js';
import type { ChatResponse } from '../providers/types.js';

export interface TokenTrackingInfo {
    remainingTokens?: number;
    refreshTime?: number;
}

/**
 * LLMExecutor - Utility class for executing LLM API calls with token management.
 * 
 * This class extracts the core execution logic from TokenManagerMiddleware and
 * LLMExecutionMiddleware so it can be called multiple times in fallback scenarios
 * without violating the middleware single-call contract.
 */
export class LLMExecutor {
    private tokenTracking: Record<string, TokenTrackingInfo> = {};
    private encoder = getEncoding('cl100k_base');

    /**
     * Calculate estimated tokens for a request
     */
    calculateTokens(context: PipelineContext): number {
        let estimatedTokens = 0;
        for (const msg of context.request.messages) {
            estimatedTokens += this.encoder.encode(msg.content).length;
        }
        const maxTokens = context.request.max_tokens || 1024;
        return estimatedTokens + maxTokens;
    }

    /**
     * Check if provider has enough tokens available
     */
    hasEnoughTokens(providerId: string, requiredTokens: number): boolean {
        const tracker = this.tokenTracking[providerId];
        if (tracker && tracker.remainingTokens !== undefined) {
            // Check if tokens should have refreshed based on reset time
            if (tracker.refreshTime && Date.now() >= tracker.refreshTime) {
                delete this.tokenTracking[providerId];
                return true;
            }
            return tracker.remainingTokens >= requiredTokens;
        }
        // If no tracking info, assume provider is available
        return true;
    }

    /**
     * Deduct tokens from provider's tracked quota
     */
    private deductTokens(providerId: string, tokens: number): void {
        const tracker = this.tokenTracking[providerId];
        if (tracker && tracker.remainingTokens !== undefined) {
            tracker.remainingTokens -= tokens;
        }
    }

    /**
     * Update token tracking from response headers (drift correction)
     */
    private updateTokenTracking(providerId: string, headers: Record<string, string | string[] | undefined>): void {
        if (!headers) return;

        // Helper to get first string value from header (handles arrays)
        const getHeader = (key: string): string | undefined => {
            const val = headers[key];
            if (Array.isArray(val)) return val[0];
            return val;
        };

        // Look for standard rate limit headers across various providers
        const remainingTokensStr =
            getHeader('x-ratelimit-remaining-tokens') ||
            getHeader('x-ratelimit-remaining-tokens-minute') ||
            getHeader('x-ratelimit-tokens-remaining');

        const resetTimeStr =
            getHeader('x-ratelimit-reset-tokens') ||
            getHeader('x-ratelimit-reset-requests');

        if (remainingTokensStr) {
            const remaining = parseInt(remainingTokensStr, 10);
            if (!isNaN(remaining)) {
                this.tokenTracking[providerId] = this.tokenTracking[providerId] || {};
                this.tokenTracking[providerId].remainingTokens = remaining;

                if (resetTimeStr) {
                    const resetVal = parseFloat(resetTimeStr);
                    if (!isNaN(resetVal)) {
                        this.tokenTracking[providerId].refreshTime = Date.now() + (resetVal * 1000);
                    }
                }
            }
        }
    }

    /**
     * Try to execute an LLM request with a specific provider
     * 
     * This method combines token management and LLM execution in one atomic operation,
     * allowing the router to try multiple providers without calling next() multiple times.
     * 
     * @param context - The pipeline context
     * @param providerId - The provider to use
     * @param modelId - The model to request
     * @returns The response if successful, null if failed
     * @throws Error if token limit exceeded or provider not found
     */
    async tryProvider(
        context: PipelineContext,
        providerId: string,
        modelId: string
    ): Promise<ChatResponse | null> {
        // 1. Calculate token requirements
        const totalEstimated = this.calculateTokens(context);
        context.estimatedTokens = totalEstimated - (context.request.max_tokens || 1024);

        // 2. Check token limits
        if (!this.hasEnoughTokens(providerId, totalEstimated)) {
            const tracker = this.tokenTracking[providerId];
            throw new Error(
                `[LLMExecutor] Exceeded tracked tokens for ${providerId}. ` +
                `Requires ${totalEstimated}, remaining ${tracker?.remainingTokens || 0}`
            );
        }

        // 3. Deduct tokens proactively
        this.deductTokens(providerId, totalEstimated);

        // 4. Get provider and execute
        const registry = ProviderRegistry.getInstance();
        const provider = registry.getProvider(providerId);

        if (!provider) {
            throw new Error(`[LLMExecutor] Provider ${providerId} not found`);
        }

        // 5. Make the API call
        const response = await provider.chat(context.request);

        // 6. Update token tracking from response headers (drift correction)
        if (response && response._headers) {
            this.updateTokenTracking(providerId, response._headers);
        }

        return response;
    }

    /**
     * Get current token tracking state
     */
    getTokenState(): Record<string, TokenTrackingInfo> {
        return this.tokenTracking;
    }

    /**
     * Set token tracking state (for sharing state with TokenManagerMiddleware)
     */
    setTokenState(state: Record<string, TokenTrackingInfo>): void {
        this.tokenTracking = state;
    }

    /**
     * Clear token tracking state
     */
    flush(): void {
        this.tokenTracking = {};
    }
}
