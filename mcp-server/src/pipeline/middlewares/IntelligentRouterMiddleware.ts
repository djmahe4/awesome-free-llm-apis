import { ProviderRegistry } from '../../providers/registry.js';
import { TaskType } from '../middleware.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';
import { LLMExecutor } from '../../utils/LLMExecutor.js';
import { ContextManager } from '../../utils/ContextManager.js';

export class IntelligentRouterMiddleware implements Middleware {
    name = 'IntelligentRouterMiddleware';

    private executor: LLMExecutor;
    private contextManager: ContextManager;

    constructor(executor?: LLMExecutor) {
        this.executor = executor || new LLMExecutor();
        this.contextManager = new ContextManager();
    }

    /**
     * Clear token tracking state
     */
    flush(): void {
        this.executor.flush();
    }

    /**
     * Get token tracking state for reporting
     */
    getTokenState() {
        return this.executor.getTokenState();
    }

    /**
     * Optimized task-to-model routing map.
     * 
     * Design principles:
     * 1. FREE models prioritized first (OpenRouter :free, GitHub Models, Cloudflare)
     * 2. All 15 providers utilized efficiently
     * 3. Task-appropriate models based on capabilities
     * 4. Fallback order: Best free → Best paid → Acceptable alternatives
     * 5. Proven reliable models first (based on real-world testing)
     * 
     * Total: 79 models across 15 providers
     * 
     * NOTE: Some OpenRouter models removed due to issues:
     * - nvidia/nemotron-nano-9b-v2:free → Invalid model ID (404)
     * - nvidia/nemotron-3-super:free → Invalid model ID (404)
     * - nvidia/nemotron-3-nano-30b-a3b:free → Invalid model ID (404)
     * - minimax/minimax-m2.5:free → Guardrail restrictions (404)
     * 
     * Correct model ID: nvidia/nemotron-mini-4b-instruct:free
     */
    private taskRouteMap: Record<string, string[]> = {
        [TaskType.Coding]: [
            // FREE TIER - Prioritized (proven reliable)
            '@cf/qwen/qwq-32b',                           // Cloudflare - Free, reasoning focused (100% success)
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free 70B (100% success)
            'qwen/qwen3-coder-480b-a35b-instruct:free',  // OpenRouter - Best free coding model (480B!)
            'DeepSeek-R1',                               // GitHub Models - Free, excellent reasoning
            'openai/gpt-oss-120b:free',                  // OpenRouter - Free GPT alternative
            'meta-llama/llama-3.3-70b-instruct:free',   // OpenRouter - Free 70B
            // PAID TIER - High quality fallbacks
            'gemini-3.1-pro-preview',                    // Gemini - Excellent coding
            'gemini-2.5-flash',                          // Gemini - Fast, reliable
            'deepseek-ai/DeepSeek-R1',                   // Kluster/HuggingFace - Top reasoning
            'llama-3.3-70b-versatile',                   // Groq - Fast inference
            'qwen-3-235b-a22b-instruct-2507',            // Cerebras - 235B powerhouse
            'Qwen/Qwen3-235B-A22B',                      // Kluster/NVIDIA - 235B
            'qwen2.5-coder-32b-instruct',                // LLM7 - Specialized coder
            'mistral-large-latest',                      // Mistral - Direct
            'glm-4.5-flash',                             // Zhipu - Fast
        ],
        [TaskType.Moderation]: [
            // FREE TIER - Proven reliable first
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free, fast (100% success)
            'nvidia/nemotron-mini-4b-instruct:free',     // OpenRouter - Fast classifier
            'arcee-ai/trinity-mini:free',                // OpenRouter - Fast moderation
            'z-ai/glm-4.5-air:free',                     // OpenRouter - GLM classifier
            // PAID TIER - Accurate
            'gemini-2.5-flash',                          // Gemini - Fast, accurate
            'gemini-3.1-flash-lite-preview',             // Gemini - Ultra fast
            'glm-4-flash',                               // Zhipu - Fast classification
            'glm-4.5-flash',                             // Zhipu - Updated
            'ministral-8b-latest',                       // Mistral - Lightweight, fast
            'llama-3.3-70b-versatile',                   // Groq - Fast inference
            'llama3.1-8b',                               // Cerebras - Fast inference
            'google/gemma-2-2b-it',                      // HuggingFace - Lightweight
        ],
        [TaskType.Classification]: [
            // FREE TIER - Proven reliable first
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free (100% success)
            'nvidia/nemotron-mini-4b-instruct:free',     // OpenRouter - Classification specialist
            'arcee-ai/trinity-mini:free',                // OpenRouter - Fast
            'z-ai/glm-4.5-air:free',                     // OpenRouter - GLM classifier
            // PAID TIER
            'gemini-2.5-flash',                          // Gemini - Fast, accurate
            'glm-4-flash',                               // Zhipu - Excellent classifier
            'glm-4.5-flash',                             // Zhipu - Updated
            'llama-4-scout-17b-16e-instruct',            // Groq - Fast inference
            'llama-3.3-70b-versatile',                   // Groq - Versatile
            'ministral-8b-latest',                       // Mistral - Lightweight
            'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', // Kluster
            'llama3.1-8b',                               // Cerebras - Fast
        ],
        [TaskType.UserIntent]: [
            // FREE TIER - Proven reliable first
            'nvidia/nemotron-mini-4b-instruct:free',     // OpenRouter - Intent specialist
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free (100% success)
            'arcee-ai/trinity-mini:free',                // OpenRouter - Fast understanding
            'z-ai/glm-4.5-air:free',                     // OpenRouter - GLM
            'Llama-3.3-70B-Instruct',                    // GitHub Models - Free
            // PAID TIER
            'gemini-2.5-flash',                          // Gemini - Fast, reliable
            'glm-4-flash',                               // Zhipu - Fast, accurate
            'glm-4.5-flash',                             // Zhipu - Updated
            'llama-4-scout-17b-16e-instruct',            // Groq - Fast
            'llama-3.3-70b-versatile',                   // Groq - Versatile
            'mistral-small-latest',                      // Mistral - Balanced
        ],
        [TaskType.SemanticSearch]: [
            // FREE TIER - Proven reliable first
            'arcee-ai/trinity-large-preview:free',       // OpenRouter - Semantic specialist (proven)
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free (100% success)
            'qwen/qwen3-next-80b-a3b-instruct:free',     // OpenRouter - 80B semantic
            'openai/gpt-oss-120b:free',                  // OpenRouter - Large OSS
            // PAID TIER - Retrieval optimized
            'command-r-plus-08-2024',                    // Cohere - RAG optimized
            'gemini-2.5-flash',                          // Gemini - Fast
            'gemini-2.5-pro',                            // Gemini - Strong understanding
            'Qwen/Qwen3-235B-A22B',                      // Kluster/NVIDIA - 235B
            'llama-3.3-70b-versatile',                   // Groq - Versatile
            'c4ai-aya-expanse-32b',                      // Cohere - Multilingual
            'mistral-large-latest',                      // Mistral - Large
        ],
        [TaskType.Summarization]: [
            // FREE TIER - Proven reliable first
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free (100% success)
            'mistralai/mistral-small-3.1-24b:free',      // OpenRouter - Good summarizer
            'meta-llama/llama-3.3-70b-instruct:free',    // OpenRouter - 70B free
            'openai/gpt-oss-20b:free',                   // OpenRouter - Efficient
            'Llama-3.3-70B-Instruct',                    // GitHub Models - Free
            // PAID TIER
            'command-a-03-2025',                         // Cohere - Summarization expert (proven)
            'gemini-2.5-flash',                          // Gemini - Balanced
            'gemini-3.1-flash-preview',                  // Gemini - Fast, good summary
            'llama-3.3-70b-versatile',                   // Groq - Versatile
            'meta/llama-3.3-70b-instruct',               // NVIDIA - Enterprise
            'llama-4-scout-17b-16e-instruct',            // Groq - Fast
            'qwen3.5',                                   // Ollama Cloud
        ],
        [TaskType.EntityExtraction]: [
            // FREE TIER - Proven reliable first (removed problematic models)
            'arcee-ai/trinity-large-preview:free',       // OpenRouter - Understanding (proven)
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free (100% success)
            'z-ai/glm-4.5-air:free',                     // OpenRouter - Structured
            'qwen/qwen3-next-80b-a3b-instruct:free',     // OpenRouter - 80B
            // PAID TIER
            'gemini-2.5-flash',                          // Gemini - Fast, reliable
            'gemini-3.1-flash-lite-preview',             // Gemini - Fast extraction
            'Qwen/Qwen3-235B-A22B',                      // Kluster/NVIDIA - 235B precise
            'command-r-plus-08-2024',                    // Cohere - Extraction optimized
            'glm-4.5-flash',                             // Zhipu - Structured output
            'llama-3.3-70b-versatile',                   // Groq - Versatile
            'deepseek-ai/DeepSeek-V3',                   // SiliconFlow - Latest
        ],
        [TaskType.Chat]: [
            // FREE TIER - Proven reliable first
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',  // Cloudflare - Free 70B (100% success)
            'gpt-4o',                                    // GitHub Models - Free GPT-4o!
            'Llama-3.3-70B-Instruct',                    // GitHub Models - Free 70B
            'DeepSeek-R1',                               // GitHub Models - Free reasoning
            'openai/gpt-oss-120b:free',                  // OpenRouter - 120B OSS
            'meta-llama/llama-3.3-70b-instruct:free',    // OpenRouter - Free 70B
            'liquid/lfm2.5-1.2b-thinking:free',          // OpenRouter - Thinking
            'stepfun/step-3.5-flash:free',               // OpenRouter - Fast
            // PAID TIER - Premium conversational
            'gemini-2.5-flash',                          // Gemini - Fast, smart
            'gemini-2.5-pro',                            // Gemini - Pro tier
            'llama-3.3-70b-versatile',                   // Groq - Fast inference
            'deepseek-ai/DeepSeek-V3',                   // SiliconFlow - Latest DeepSeek
            'mistral-large-latest',                      // Mistral - Premium
            'deepseek-v3.2',                             // Ollama Cloud
            'kimi-k2.5',                                 // Ollama Cloud - Multilingual
            'moonshotai/kimi-k2-instruct',               // Groq - Kimi
            'c4ai-aya-expanse-32b',                      // Cohere - Multilingual
        ]
    };

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        let taskType = context.taskType;
        if (!taskType || !this.taskRouteMap[taskType as string]) {
            taskType = TaskType.Chat;
            context.taskType = taskType;
        }

        // Calculate estimated tokens for context window filtering
        let estimatedTokens = this.executor.calculateTokens(context);

        // Always start with the explicitly requested model, then fall back to tier
        const requestedModel = context.request.model;
        // 1. Initial models for context window check
        const initialModels = [...new Set([requestedModel, ...this.taskRouteMap[taskType as string]])].filter(Boolean);

        const registry = ProviderRegistry.getInstance();
        let contextCompressed = false;

        // 1. Pre-filter available providers once
        const availableProviders = registry.getAllProviders().filter(p => p.isAvailable());

        // 2. Context Overflow Guard: Check if we need to compress before attempting any providers
        const maxAvailableContext = availableProviders
            .flatMap(p => p.models)
            .reduce((max, m) => m.contextWindow ? Math.max(max, m.contextWindow) : max, 0);


        if (maxAvailableContext > 0 && estimatedTokens > maxAvailableContext) {

            // Target: leave 20% headroom
            const targetTokens = Math.floor(maxAvailableContext * 0.8) - (context.request.max_tokens || 1024);

            const summarizer = async (text: string): Promise<string> => {
                const summaryCtx: PipelineContext = {
                    request: { model: 'any', messages: [{ role: 'user', content: text }], max_tokens: 512 },
                    taskType: TaskType.Summarization,
                };

                for (const model of this.taskRouteMap[TaskType.Summarization] || []) {
                    const providers = availableProviders.filter(p => p.models.some(m => m.id === model));
                    for (const provider of providers) {
                        try {
                            summaryCtx.request.model = model;
                            const res = await this.executor.tryProvider(summaryCtx, provider.id, model);
                            return res?.choices[0]?.message?.content ?? '';
                        } catch { /* Try next */ }
                    }
                }
                throw new Error('No summarization provider');
            };

            try {
                const compressionResult = await this.contextManager.compress(context, targetTokens, summarizer);
                context.request.messages = compressionResult.messages;
                estimatedTokens = this.executor.calculateTokens(context);
                contextCompressed = true;
            } catch (err: any) {
                console.warn(`[Router] Compression failed: ${err.message}`);
            }
        }

        // --- Main fallback loop ---
        let lastError: Error | null = null;
        const fallbackModels = this.taskRouteMap[taskType as string] || this.taskRouteMap[TaskType.Chat];
        const tierModels = [...new Set([requestedModel, ...fallbackModels])].filter(Boolean) as string[];

        for (const modelId of tierModels) {
            const scoredProviders = availableProviders
                .filter(p => p.models.some(m => m.id === modelId))
                .map(provider => {
                    const modelMetadata = provider.models.find(m => m.id === modelId);
                    if (modelMetadata && modelMetadata.contextWindow && modelMetadata.contextWindow < estimatedTokens) {
                        return { provider, score: -1 };
                    }

                    const usage = (provider as any).getUsageStats?.() || { requestCountMinute: 0 };
                    const rpmLimit = provider.rateLimits.rpm || 60;
                    const rateLimitScore = 1 - (usage.requestCountMinute / rpmLimit);
                    const tokenScore = this.executor.getTokenScore(provider.id);

                    return { provider, score: Math.max(0, rateLimitScore * tokenScore) };
                })
                .filter(p => p.score >= 0)
                .sort((a, b) => b.score - a.score);


            for (const { provider } of scoredProviders) {
                try {
                    const response = await this.executor.tryProvider(context, provider.id, modelId);
                    if (response) {
                        if (contextCompressed) (context as any).contextCompressed = true;
                        context.response = response;
                        context.providerId = provider.id;
                        context.request.model = modelId;
                        await next();
                        return;
                    }
                } catch (err: any) {
                    lastError = err;
                    console.warn(`[Router] Provider ${provider.id} failed for model ${modelId}: ${err.message}. Cascading...`);
                    continue;
                }
            }
        }

        throw new Error(
            `[Router] Exhausted all fallback models for task ${taskType}. ` +
            `Last error: ${lastError?.message || 'No available providers'}`
        );
    }
}
