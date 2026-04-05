import { getEncoding } from 'js-tiktoken';
import { ProviderRegistry } from '../providers/registry.js';
import type { PipelineContext } from '../pipeline/middleware.js';
import type { ChatResponse, Message } from '../providers/types.js';

export interface TokenTrackingInfo {
    remainingTokens?: number;
    refreshTime?: number;
    remainingRequests?: number;
    requestsRefreshTime?: number;
    lastSuccessTime?: number;
}

/**
 * LLMExecutor - Utility class for executing LLM API calls with token management.
 * 
 * This class extracts the core execution logic from TokenManagerMiddleware and
 * the removed LLMExecutionMiddleware so it can be called multiple times in fallback scenarios
 * without violating the middleware single-call contract.
 */
export class LLMExecutor {
    private tokenTracking: Record<string, TokenTrackingInfo> = {};
    private encoder = getEncoding('cl100k_base');

    /**
     * Calculate estimated tokens for a request
     */
    calculateTokens(messages: Message[]): number {
        let totalChars = 0;
        for (const msg of messages) {
            totalChars += msg.content.length;
        }

        // Optimization: If the string is massive (> 20k chars), 
        // return a safe upper bound estimate immediately
        // to avoid hanging on Tiktoken encoding.
        if (totalChars > 20000) {
            return Math.ceil(totalChars / 2); // Very conservative estimate (2 chars per token)
        }

        let total = 0;
        for (const msg of messages) {
            total += this.encoder.encode(msg.content).length + 4;
        }
        return total;
    }

    /**
     * Get a token and RPM-based health score for a provider (0-1)
     */
    getTokenScore(providerId: string): number {
        const tracker = this.tokenTracking[providerId];
        if (!tracker) return 1.0; // Assume healthy if no info

        let score = 1.0;

        if (tracker.remainingTokens !== undefined) {
            if (tracker.refreshTime && Date.now() >= tracker.refreshTime) {
                // Tokens refreshed
            } else {
                // Normalize score: 100k tokens = 1.0 score
                score = Math.min(score, tracker.remainingTokens / 100000);
            }
        }

        if (tracker.remainingRequests !== undefined) {
            if (tracker.requestsRefreshTime && Date.now() >= tracker.requestsRefreshTime) {
                // Requests refreshed
            } else {
                if (tracker.remainingRequests < 2) {
                    score = Math.min(score, 0.1); // Severely penalize if almost out of requests
                } else if (tracker.remainingRequests < 10) {
                    score = Math.min(score, 0.5); // Penalize if getting low
                }
            }
        }

        return Math.max(0, score);
    }

    /**
     * Check if provider has enough tokens and requests available
     */
    hasEnoughTokens(providerId: string, requiredTokens: number): boolean {
        const tracker = this.tokenTracking[providerId];
        if (!tracker) return true;

        let tokensOk = true;
        let requestsOk = true;

        if (tracker.remainingTokens !== undefined) {
            if (tracker.refreshTime && Date.now() >= tracker.refreshTime) {
                tracker.remainingTokens = undefined; // Lazy clear
            } else {
                tokensOk = tracker.remainingTokens >= requiredTokens;
            }
        }

        if (tracker.remainingRequests !== undefined) {
            if (tracker.requestsRefreshTime && Date.now() >= tracker.requestsRefreshTime) {
                tracker.remainingRequests = undefined;
            } else {
                requestsOk = tracker.remainingRequests > 0;
            }
        }

        return tokensOk && requestsOk;
    }

    /**
     * Deduct tokens and requests from provider's tracked quota
     */
    private deductTokens(providerId: string, tokens: number): void {
        const tracker = this.tokenTracking[providerId];
        if (tracker) {
            if (tracker.remainingTokens !== undefined) {
                tracker.remainingTokens -= tokens;
            }
            if (tracker.remainingRequests !== undefined) {
                tracker.remainingRequests -= 1;
            }
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

        const remainingRequestsStr =
            getHeader('x-ratelimit-remaining-requests') ||
            getHeader('x-ratelimit-requests-remaining') ||
            getHeader('x-ratelimit-remaining-requests-minute');

        const resetTokensTimeStr = getHeader('x-ratelimit-reset-tokens');
        const resetRequestsTimeStr = getHeader('x-ratelimit-reset-requests');

        this.tokenTracking[providerId] = this.tokenTracking[providerId] || {};
        this.tokenTracking[providerId].lastSuccessTime = Date.now();

        if (remainingTokensStr) {
            const remaining = parseInt(remainingTokensStr, 10);
            if (!isNaN(remaining)) {
                this.tokenTracking[providerId].remainingTokens = remaining;

                if (resetTokensTimeStr) {
                    const resetVal = parseFloat(resetTokensTimeStr);
                    if (!isNaN(resetVal)) {
                        this.tokenTracking[providerId].refreshTime = Date.now() + (resetVal * 1000);
                    }
                }
            }
        }

        if (remainingRequestsStr) {
            const remainingReq = parseInt(remainingRequestsStr, 10);
            if (!isNaN(remainingReq)) {
                this.tokenTracking[providerId].remainingRequests = remainingReq;

                // Fallback to tokens reset time if request reset time is not provided separately
                const resetStr = resetRequestsTimeStr || resetTokensTimeStr;
                if (resetStr) {
                    const resetVal = parseFloat(resetStr);
                    if (!isNaN(resetVal)) {
                        this.tokenTracking[providerId].requestsRefreshTime = Date.now() + (resetVal * 1000);
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
        // 1. Calculate tokens once per set of messages
        if (context.estimatedTokens === undefined) {
            const promptTokens = this.calculateTokens(context.request.messages);
            context.estimatedTokens = promptTokens;
        }

        const totalWithCompletion = context.estimatedTokens + (context.request.max_tokens || 1024);

        // 2. Check token limits (Permissive: Log warning but proceed)
        if (!this.hasEnoughTokens(providerId, totalWithCompletion)) {
            const tracker = this.tokenTracking[providerId];
            console.warn(
                `[LLMExecutor] Local token tracking suggests exhaustion for ${providerId}. ` +
                `Requires ${totalWithCompletion}, remaining ${tracker?.remainingTokens || 0}. ` +
                `Proceeding with best-effort attempt.`
            );
        }

        // 3. Deduct resources PROACTIVELY
        this.deductTokens(providerId, totalWithCompletion);

        // 4. Get provider and execute
        const registry = ProviderRegistry.getInstance();
        const provider = registry.getProvider(providerId);

        if (!provider) {
            throw new Error(`[LLMExecutor] Provider ${providerId} not found`);
        }

        // 5. Make the API call
        const previousModel = context.request.model;
        context.request.model = modelId;

        let response: ChatResponse | null = null;
        try {
            response = await provider.chat(context.request);
        } finally {
            if (!response) {
                context.request.model = previousModel;
            }
        }

        // 6. Update token tracking from response headers (drift correction)
        if (response && response._headers) {
            this.updateTokenTracking(providerId, response._headers);
        }

        return response;
    }

    /**
     * Minimal standalone prompt execution (for subtasks/decomposition).
     */
    async prompt(
        messages: Message[],
        modelOverride: string = 'any',
        options: { taskType?: string } = {}
    ): Promise<ChatResponse> {
        const registry = ProviderRegistry.getInstance();
        const providers = registry.getAvailableProviders();
        
        if (providers.length === 0) {
            throw new Error('No providers available');
        }

        // Pick matching models
        const targetModels = modelOverride === 'any' 
            ? ['gemini-2.0-flash', 'llama-3.3-70b-versatile', 'glm-4.7'] 
            : [modelOverride];

        for (const modelId of targetModels) {
            for (const p of providers) {
                if (modelOverride === 'any' || p.models.some(m => m.id === modelId)) {
                    try {
                        const res = await p.chat({
                            model: modelId === 'any' ? p.models[0].id : modelId,
                            messages
                        });
                        return res;
                    } catch (err) {
                        continue;
                    }
                }
            }
        }

        throw new Error(`Failed to execute prompt with any provider.`);
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
