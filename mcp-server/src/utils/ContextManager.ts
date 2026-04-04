import { getEncoding } from 'js-tiktoken';
import type { Message } from '../providers/types.js';
import type { PipelineContext } from '../pipeline/middleware.js';

/**
 * Controls how context overflow is handled.
 */
export type OverflowStrategy = 'sliding-window' | 'truncate-oldest' | 'chunk-mapreduce';

export interface ContextCompressionResult {
    messages: Message[];
    strategy: OverflowStrategy;
    originalTokens: number;
    compressedTokens: number;
    chunksProcessed?: number;
}

/**
 * ContextManager - Handles context overflow without losing semantic meaning.
 *
 * Three-tier strategy:
 * 1. Sliding Window: Keep recent messages + compressed summary of older ones.
 * 2. Truncate-Oldest: Simple hard cut of oldest non-system messages.
 * 3. Chunk MapReduce: Split large inputs into chunks, process each, then merge.
 *
 * Priority: sliding-window → truncate-oldest (for chat tasks)
 * For document-heavy tasks: chunk-mapreduce is orchestrated by the caller.
 */
export class ContextManager {
    private encoder = getEncoding('cl100k_base');

    /**
     * Count tokens for a message array.
     */
    countTokens(messages: Message[]): number {
        let totalChars = 0;
        for (const msg of messages) {
            totalChars += msg.content.length;
        }

        // Optimization: If the string is massive (> 20k chars), 
        // return a safe upper bound estimate immediately
        if (totalChars > 20000) {
            return Math.ceil(totalChars / 2); // Same factor as LLMExecutor
        }

        let total = 0;
        for (const msg of messages) {
            total += this.encoder.encode(msg.content).length + 4; // ~4 overhead per msg
        }
        return total;
    }

    /**
     * Count tokens for a single string.
     */
    countStringTokens(text: string): number {
        return this.encoder.encode(text).length;
    }

    /**
     * Main entry: compress a context to fit within targetTokens.
     * Returns the compressed message array and metadata.
     *
     * @param context     - The pipeline context to compress
     * @param targetTokens - Max tokens allowed (contextWindow - max_tokens reserved)
     * @param summarizer  - Async fn that summarizes a block of text using an LLM
     */
    async compress(
        context: PipelineContext,
        targetTokens: number,
        summarizer: (text: string) => Promise<string>
    ): Promise<ContextCompressionResult> {
        const messages = [...context.request.messages];
        const originalTokens = this.countTokens(messages);

        // Already fits — nothing to do
        if (originalTokens <= targetTokens) {
            return { messages, strategy: 'sliding-window', originalTokens, compressedTokens: originalTokens };
        }

        // --- Tier 1: Sliding Window with Summarization ---
        const result = await this.slidingWindow(messages, targetTokens, summarizer);
        if (result.compressedTokens <= targetTokens) {
            return result;
        }

        // --- Tier 2: Truncate Oldest (fast fallback) ---
        const truncated = this.truncateOldest(messages, targetTokens);
        return truncated;
    }

    /**
     * Sliding Window Strategy:
     * - Preserves the system prompt (if any)
     * - Compresses older messages into a single summary injected as a system note
     * - Always keeps the N most recent messages verbatim
     * - Summary is generated using a provided lightweight LLM call
     */
    async slidingWindow(
        messages: Message[],
        targetTokens: number,
        summarizer: (text: string) => Promise<string>
    ): Promise<ContextCompressionResult> {
        const originalTokens = this.countTokens(messages);

        const systemMsgs = messages.filter(m => m.role === 'system');
        const nonSystemMsgs = messages.filter(m => m.role !== 'system');

        // Keep at minimum the last 4 messages (2 exchanges) verbatim
        const KEEP_RECENT = Math.min(4, nonSystemMsgs.length);
        const recentMsgs = nonSystemMsgs.slice(-KEEP_RECENT);
        const oldMsgs = nonSystemMsgs.slice(0, -KEEP_RECENT);

        if (oldMsgs.length === 0) {
            // Can't compress further without dropping recent context — return as-is
            return {
                messages,
                strategy: 'sliding-window',
                originalTokens,
                compressedTokens: originalTokens,
            };
        }

        const historyText = oldMsgs
            .map(m => `${m.role.toUpperCase()}: ${m.content}`)
            .join('\n---\n');

        const historyTextTokens = this.countStringTokens(historyText);
        const MAX_SUMMARY_CONTEXT = 32000;

        let summary: string;
        try {
            if (historyTextTokens > MAX_SUMMARY_CONTEXT) {
                // Output too massive for a single API call, we must chunk the summary itself
                const words = historyText.split(/\s+/);
                const chunks: string[] = [];
                let currentChunk: string[] = [];
                let currentTokens = 0;

                for (const word of words) {
                    const wordTokens = this.countStringTokens(word + ' ');
                    if (currentTokens + wordTokens > MAX_SUMMARY_CONTEXT && currentChunk.length > 0) {
                        chunks.push(currentChunk.join(' '));
                        currentChunk = [];
                        currentTokens = 0;
                    }
                    currentChunk.push(word);
                    currentTokens += wordTokens;
                }
                if (currentChunk.length > 0) chunks.push(currentChunk.join(' '));

                console.warn(`[ContextManager] historyText is massive (${historyTextTokens} tokens), chunking into ${chunks.length} parts for safe summarization...`);

                const chunkSummaries = await Promise.allSettled(
                    chunks.map(chunk => summarizer(`Summarize this segment of conversation concisely:\n\n${chunk}`))
                );
                const successfulSummaries = chunkSummaries
                    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
                    .map(r => r.value);

                if (successfulSummaries.length === 0) throw new Error('All chunk summaries failed');

                // Reduce
                summary = await summarizer(
                    `Merge these sequential conversation summaries into one dense summary. Preserve facts/context:\n\n${successfulSummaries.join('\n---\n')}`
                );
            } else {
                summary = await summarizer(
                    `Summarize the following conversation history concisely, preserving all key facts, decisions, and context. Be dense — output only the summary, no preamble:\n\n${historyText}`
                );
            }
        } catch {
            // If summarization fails, fall back to simple truncation
            return this.truncateOldest(messages, targetTokens);
        }

        const summaryMsg: Message = {
            role: 'system',
            content: `[Context Summary — earlier conversation]: ${summary}`,
        };

        const compressed: Message[] = [...systemMsgs, summaryMsg, ...recentMsgs];
        const compressedTokens = this.countTokens(compressed);

        return {
            messages: compressed,
            strategy: 'sliding-window',
            originalTokens,
            compressedTokens,
        };
    }

    /**
     * Truncate-Oldest Strategy:
     * Hard-drops oldest non-system messages until within budget.
     * Fast but lossy — use only as last resort before chunking.
     */
    truncateOldest(messages: Message[], targetTokens: number): ContextCompressionResult {
        const originalTokens = this.countTokens(messages);
        const systemMsgs = messages.filter(m => m.role === 'system');
        let nonSystemMsgs = messages.filter(m => m.role !== 'system');

        // 1. First drop whole messages
        while (nonSystemMsgs.length > 1) {
            const candidate = [...systemMsgs, ...nonSystemMsgs];
            if (this.countTokens(candidate) <= targetTokens) break;
            nonSystemMsgs = nonSystemMsgs.slice(1);
        }

        // 2. If still over budget and one message remains, truncate that one message
        let result = [...systemMsgs, ...nonSystemMsgs];
        if (this.countTokens(result) > targetTokens && nonSystemMsgs.length > 0) {
            const lastMsg = nonSystemMsgs[nonSystemMsgs.length - 1];
            const systemTokens = this.countTokens(systemMsgs);
            const remainingBudget = Math.max(0, targetTokens - systemTokens - 20); // 20 buffer

            if (remainingBudget > 50) {
                // High-performance truncation: Estimate chars from tokens (avg ~4 chars per token)
                // Use a safe factor (3 chars per token) to avoid over-truncation
                const approxChars = remainingBudget * 3;
                let truncatedContent = lastMsg.content.slice(-approxChars);

                // Refine with small word-by-word steps if still too big
                // or add back words if we have room. For emergency, we just want to BE UNDER budget.
                // We'll perform one more Tiktoken check and adjust if needed.
                let currentTokens = this.countStringTokens(truncatedContent);

                if (currentTokens > remainingBudget) {
                    // Still too big? Hard slice by tokens/chars ratio
                    const ratio = remainingBudget / currentTokens;
                    truncatedContent = truncatedContent.slice(-Math.floor(truncatedContent.length * ratio * 0.9));
                }

                nonSystemMsgs[nonSystemMsgs.length - 1] = {
                    ...lastMsg,
                    content: `[...truncated...] ${truncatedContent.trim()}`
                };
            } else {
                // Budget too small for meaningful content
                nonSystemMsgs[nonSystemMsgs.length - 1] = {
                    ...lastMsg,
                    content: `[...truncated for emergencyFallback...]`
                };
            }
            result = [...systemMsgs, ...nonSystemMsgs];
        }

        return {
            messages: result,
            strategy: 'truncate-oldest',
            originalTokens,
            compressedTokens: this.countTokens(result),
        };
    }

    /**
     * Chunk MapReduce Strategy:
     * For large single-message inputs (documents, long code).
     *
     * Split the last user message into overlapping chunks, process each with
     * a task prompt, then reduce all chunk results into a final answer.
     *
     * @param context        - Original pipeline context
     * @param chunkTokenSize - Max tokens per chunk (leave room for prompt overhead)
     * @param executor       - Async fn to process a single chunk
     * @param reducer        - Async fn to merge all chunk results into a final answer
     */
    async chunkMapReduce(
        context: PipelineContext,
        chunkTokenSize: number,
        executor: (chunkContext: PipelineContext) => Promise<string>,
        reducer: (partialResults: string[], originalContext: PipelineContext) => Promise<string>
    ): Promise<string> {
        const messages = context.request.messages;
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');

        if (!lastUserMsg) {
            throw new Error('[ContextManager] No user message found to chunk');
        }

        // Split by words to avoid breaking tokens mid-way
        const words = lastUserMsg.content.split(/\s+/);
        const chunks: string[] = [];
        let currentChunk: string[] = [];
        let currentTokens = 0;

        for (const word of words) {
            const wordTokens = this.countStringTokens(word + ' ');
            if (currentTokens + wordTokens > chunkTokenSize && currentChunk.length > 0) {
                chunks.push(currentChunk.join(' '));
                // Overlap: keep last 50 words for context continuity
                currentChunk = currentChunk.slice(-50);
                currentTokens = this.countStringTokens(currentChunk.join(' '));
            }
            currentChunk.push(word);
            currentTokens += wordTokens;
        }
        if (currentChunk.length > 0) chunks.push(currentChunk.join(' '));

        if (chunks.length === 1) {
            // No actual chunking needed
            return executor(context);
        }

        console.warn(`[ContextManager] MapReduce: splitting into ${chunks.length} chunks`);

        // Map: process each chunk independently
        const chunkResults = await Promise.allSettled(
            chunks.map((chunk, i) => {
                const chunkContext: PipelineContext = {
                    ...context,
                    request: {
                        ...context.request,
                        messages: [
                            ...messages.filter(m => m.role === 'system'),
                            {
                                role: 'user',
                                content: `[Part ${i + 1}/${chunks.length}] ${lastUserMsg.content.split(chunk)[0] ? 'Continuing from previous section. ' : ''}Process this section:\n\n${chunk}`,
                            },
                        ],
                    },
                };
                return executor(chunkContext);
            })
        );

        const successfulResults = chunkResults
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
            .map(r => r.value);

        if (successfulResults.length === 0) {
            throw new Error('[ContextManager] All chunks failed during MapReduce');
        }

        // Reduce: merge all partial results
        return reducer(successfulResults, context);
    }
}
