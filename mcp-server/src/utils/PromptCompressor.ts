import { PipelineContext, TaskType } from '../pipeline/middleware.js';
import { Provider } from '../providers/types.js';
import { LLMExecutor } from './LLMExecutor.js';
import { ContextManager } from './ContextManager.js';

export class PromptCompressor {
    private executor: LLMExecutor;
    private contextManager: ContextManager;

    constructor(executor: LLMExecutor, contextManager: ContextManager) {
        this.executor = executor;
        this.contextManager = contextManager;
    }

    /**
     * Estimates and compresses context if it exceeds thresholds, returning the updated estimated tokens.
     */
    async compressIfNeeded(
        context: PipelineContext,
        availableProviders: Provider[],
        taskRouteMap: Record<string, string[]>,
        getRemainingTimeout: () => number,
        totalBudget: number
    ): Promise<{ estimatedTokens: number; contextCompressed: boolean }> {
        const originalTokens = context.estimatedTokens ?? 
                       (context.request as any).estimatedTokens ?? 
                       this.executor.calculateTokens(context.request.messages);
        context.estimatedTokens = originalTokens;

        let estimatedTokens = originalTokens;
        let contextCompressed = false;
        let summarizationAttempts = 0;
        const MAX_SUMMARIZATION_ATTEMPTS = 5;

        // Shared summarizer helper that respects global attempt and timeout limits
        const sharedSummarizer = async (text: string) => {
            summarizationAttempts++;
            const remaining = getRemainingTimeout();

            // Strategic Bailout: If we've tried too many times or have < 60% budget left, 
            // stop trying to summarize and fall back to Tier 2 (Truncation) which is instant.
            if (summarizationAttempts > MAX_SUMMARIZATION_ATTEMPTS || remaining < (totalBudget * 0.6)) {
                throw new Error('Summarization budget or attempt limit exhausted');
            }

            const summaryPrompt = `Summarize precisely while preserving technical context: ${text}`;
            const preferredModels = taskRouteMap[TaskType.Summarization] || [];

            // 1. Try preferred models first
            for (const modelId of preferredModels) {
                for (const p of availableProviders) {
                    if (p.models.some(m => m.id === modelId)) {
                        try {
                            const currentRemaining = getRemainingTimeout();
                            if (currentRemaining < 2000) throw new Error('Timeout budget exhausted for summarization');

                            const res = await p.chat({
                                model: modelId,
                                messages: [{ role: 'user', content: summaryPrompt }],
                                timeoutMs: Math.min(currentRemaining, Math.max(15000, Math.floor(currentRemaining * 0.4)))
                            });
                            return res.choices[0].message.content;
                        } catch (err: any) {
                            continue;
                        }
                    }
                }
            }

            // 2. Fallback: try ANY available provider with ANY model that has space
            for (const p of availableProviders) {
                if (p.models.length > 0) {
                    const m = p.models[0];
                    try {
                        const currentRemaining = getRemainingTimeout();
                        if (currentRemaining < 2000) throw new Error('Timeout budget exhausted for summarization fallback');

                        const res = await p.chat({
                            model: m.id,
                            messages: [{ role: 'user', content: summaryPrompt }],
                            timeoutMs: Math.min(currentRemaining, Math.max(12000, Math.floor(currentRemaining * 0.3)))
                        });
                        return res.choices[0].message.content;
                    } catch (err: any) {
                        continue;
                    }
                }
            }

            throw new Error('All summarization providers failed.');
        };

        // Level 1: Context Compression for complex prompts (> 8000 tokens) or imminent overflow
        const maxWindow = Math.max(...availableProviders.flatMap(p => p.models).map(m => m.contextWindow || 0), 0);
        const absoluteOverflow = maxWindow > 0 && estimatedTokens > maxWindow;

        if (estimatedTokens > 8000 || absoluteOverflow) {
            const targetTokens = absoluteOverflow ? Math.min(estimatedTokens * 0.5, maxWindow * 0.8) : Math.max(4000, estimatedTokens * 0.5);

            try {
                const compResult = await this.contextManager.compress(context, targetTokens, sharedSummarizer);
                context.request.messages = compResult.messages;
                estimatedTokens = this.executor.calculateTokens(context.request.messages);
                context.estimatedTokens = estimatedTokens;
                contextCompressed = true;
            } catch (err: any) {
                const truncated = this.contextManager.truncateOldest(context.request.messages, targetTokens);
                context.request.messages = truncated.messages;
                estimatedTokens = truncated.compressedTokens;
                context.estimatedTokens = estimatedTokens;
                contextCompressed = true;
            }
        }

        // Level 2: Hard Truncation if still massive (> 12k tokens)
        if (estimatedTokens > 12000) {
            const truncated = this.contextManager.truncateOldest(context.request.messages, 8000);
            context.request.messages = truncated.messages;
            estimatedTokens = truncated.compressedTokens;
            context.estimatedTokens = estimatedTokens;
            contextCompressed = true;
        }

        return { estimatedTokens, contextCompressed };
    }
}
