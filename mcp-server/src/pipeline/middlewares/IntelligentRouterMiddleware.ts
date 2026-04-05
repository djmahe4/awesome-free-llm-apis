import { ProviderRegistry } from '../../providers/registry.js';
import { TaskType } from '../middleware.js';
import type { Message } from '../../providers/types.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';
import { LLMExecutor } from '../../utils/LLMExecutor.js';
import { ContextManager } from '../../utils/ContextManager.js';

export class IntelligentRouterMiddleware implements Middleware {
    name = 'IntelligentRouterMiddleware';

    private executor: LLMExecutor;
    private contextManager: ContextManager;

    // Model capability scores (0.0 to 1.0)
    private static readonly modelCapabilities: Record<string, number> = {
        'DeepSeek-R1': 1.0,
        'deepseek-ai/DeepSeek-R1': 1.0,
        'DeepSeek-V3': 0.9,
        'deepseek-ai/DeepSeek-V3': 0.9,
        'gemini-3.1-pro-preview': 0.95,
        'gemini-2.5-pro': 0.9,
        'gemini-2.0-flash': 0.8,
        'gemini-2.5-flash': 0.8,
        'command-r-plus-08-2024': 0.9,
        'command-a-03-2025': 0.8,
        'mistral-large-latest': 0.85,
        'mistralai/mistral-large-2-instruct': 0.85,
        'llama-3.3-70b-versatile': 0.85,
        'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8': 0.85,
        'qwen/qwen3-coder-480b-a35b-instruct:free': 0.9,
        'qwen/qwen3-next-80b-a3b-instruct:free': 0.8,
        'openai/gpt-oss-120b:free': 0.85,
        'gpt-oss-20b': 0.7,
        'glm-5.1': 0.95,
        'glm-5-turbo': 0.9,
        'glm-4.7': 0.85,
        'glm-4.6': 0.8,
        'glm-4.5-air': 0.7,
    };

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

    private static readonly keywordTaskMap: Record<string, TaskType> = {
        // Coding
        'code': TaskType.Coding, 'coding': TaskType.Coding, 'debug': TaskType.Coding, 'implement': TaskType.Coding,
        'function': TaskType.Coding, 'class': TaskType.Coding, 'typescript': TaskType.Coding, 'javascript': TaskType.Coding,
        'python': TaskType.Coding, 'rust': TaskType.Coding, 'go': TaskType.Coding, 'fix': TaskType.Coding, 'refactor': TaskType.Coding,
        // Summarization
        'summary': TaskType.Summarization, 'summarize': TaskType.Summarization, 'tldr': TaskType.Summarization,
        'tl;dr': TaskType.Summarization, 'concise': TaskType.Summarization, 'brief': TaskType.Summarization,
        // Entity Extraction
        'extract': TaskType.EntityExtraction, 'extraction': TaskType.EntityExtraction, 'entities': TaskType.EntityExtraction,
        'json': TaskType.EntityExtraction, 'fields': TaskType.EntityExtraction, 'parse': TaskType.EntityExtraction,
        // Classification
        'classify': TaskType.Classification, 'classification': TaskType.Classification, 'sentiment': TaskType.Classification,
        'categorize': TaskType.Classification, 'label': TaskType.Classification,
        // Semantic Search / Research
        'search': TaskType.SemanticSearch, 'find': TaskType.SemanticSearch, 'lookup': TaskType.SemanticSearch,
        'research': TaskType.SemanticSearch, 'discover': TaskType.SemanticSearch, 'knowledge': TaskType.SemanticSearch,
        // Moderation
        'moderate': TaskType.Moderation, 'moderation': TaskType.Moderation, 'safety': TaskType.Moderation,
        'filter': TaskType.Moderation, 'policy': TaskType.Moderation,
        // User Intent / Planning
        'intent': TaskType.UserIntent, 'plan': TaskType.UserIntent, 'decompose': TaskType.UserIntent,
    };

    /**
     * Automatically classifies the task type based on explicit keywords or prompt content.
     */
    private autoClassify(messages: Message[], explicitKeywords?: string[]): TaskType {
        // 1. Prioritize Explicit Keywords (Majority Voting)
        if (explicitKeywords && explicitKeywords.length > 0) {
            const counts: Record<string, number> = {};
            for (const kw of explicitKeywords) {
                const type = IntelligentRouterMiddleware.keywordTaskMap[kw.toLowerCase()];
                if (type) {
                    counts[type] = (counts[type] || 0) + 1;
                }
            }

            const winners = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            if (winners.length > 0) {
                // If there's a clear winner or just one type, use it
                if (winners.length === 1 || winners[0][1] > winners[1][1]) {
                    return winners[0][0] as TaskType;
                }
                // If it's a tie, we'll continue to message-based fallback
            }
        }

        // 2. Fallback to Message Content Analysis
        const lastMsg = messages[messages.length - 1]?.content.toLowerCase() || '';

        if (lastMsg.includes('```') || lastMsg.includes('function') || lastMsg.includes('class') || lastMsg.includes('debug') || lastMsg.includes('implement')) {
            return TaskType.Coding;
        }
        if (lastMsg.includes('summarize') || lastMsg.includes('summarization') || lastMsg.includes('tldr') || lastMsg.includes('tl;dr') || lastMsg.includes('concise')) {
            return TaskType.Summarization;
        }
        if (lastMsg.includes('extract') || lastMsg.includes('entities') || lastMsg.includes('json') || lastMsg.includes('fields')) {
            return TaskType.EntityExtraction;
        }
        if (lastMsg.includes('classify') || lastMsg.includes('sentiment') || lastMsg.includes('categorize')) {
            return TaskType.Classification;
        }
        if (lastMsg.includes('search') || lastMsg.includes('find') || lastMsg.includes('lookup')) {
            return TaskType.SemanticSearch;
        }

        return TaskType.Chat;
    }

    /**
     * Detects if a prompt is complex enough to warrant decomposition.
     */
    private isComplex(messages: Message[]): boolean {
        const lastMsg = messages[messages.length - 1]?.content || '';
        const lower = lastMsg.toLowerCase();

        // Complex if it has numbered steps, multiple questions, or specific keywords
        const stepCount = (lastMsg.match(/\d\./g) || []).length;
        const questionCount = (lastMsg.match(/\?/g) || []).length;
        const hasSequencers = lower.includes('first') && (lower.includes('then') || lower.includes('finally'));
        const isLong = lastMsg.length > 1000;

        return stepCount >= 3 || (questionCount >= 2 && isLong) || hasSequencers;
    }

    /**
     * Decomposes a complex task into subtasks and executes them.
     */
    private async decomposeAndExecute(context: PipelineContext): Promise<void> {
        console.debug(`[Router] Decomposing complex task...`);

        // 1. Pick a Planner model (SiliconFlow V3 or Gemini Flash)
        const plannerModels = ['deepseek-ai/DeepSeek-V3', 'gemini-2.0-flash', 'llama3.1-8b'];
        let plannerResponse: string | null = null;

        const lastMessage = context.request.messages.length > 0 
            ? context.request.messages[context.request.messages.length - 1].content 
            : 'No content provided';

        const planningPrompt = `Analyze this request and split it into a list of independent subtasks. 
Return ONLY a JSON array of strings, where each string is a clear subtask instruction.
Request: ${lastMessage}`;

        for (const modelId of plannerModels) {
            try {
                const res = await this.executor.prompt([{ role: 'user', content: planningPrompt }], modelId);
                plannerResponse = res.choices[0].message.content;
                if (plannerResponse) break;
            } catch (err) {
                console.warn(`[Router] Planner ${modelId} failed:`, err);
                continue;
            }
        }

        if (!plannerResponse) {
            console.warn(`[Router] All planners failed. Falling back to monolithic execution.`);
            return;
        }

        // Parse subtasks
        let subtasks: string[] = [];
        try {
            // Basic JSON extraction
            const jsonMatch = plannerResponse.match(/\[.*\]/s);
            subtasks = JSON.parse(jsonMatch ? jsonMatch[0] : plannerResponse);
        } catch (err) {
            console.warn(`[Router] Failed to parse planner response:`, err);
            return;
        }

        console.debug(`[Router] Executing ${subtasks.length} subtasks...`);
        const subtaskResults: string[] = [];

        for (const [i, task] of subtasks.entries()) {
            const taskType = this.autoClassify([{ role: 'user', content: task }], context.keywords);
            console.debug(`[Router] Subtask ${i + 1}: "${task.slice(0, 50)}..." (Type: ${taskType})`);

            try {
                // Execute subtask with best model for its type
                const subtaskRes = await this.executor.prompt(
                    [...context.request.messages.slice(0, -1), { role: 'user', content: task }],
                    'any', // Let executor pick best for type if it can, otherwise defaults to chat
                    { taskType }
                );
                subtaskResults.push(`### Subtask ${i + 1}: ${task}\n${subtaskRes.choices[0].message.content}`);
            } catch (err) {
                console.error(`[Router] Subtask ${i + 1} failed:`, err);
                subtaskResults.push(`### Subtask ${i + 1}: ${task}\nFAILED: ${err}`);
            }
        }

        // Final Aggregation (optional, here we just join)
        const finalContent = `I've broken your request into ${subtasks.length} subtasks:\n\n${subtaskResults.join('\n\n')}`;

        context.response = {
            id: `decomposed-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'intelligent-orchestrator',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: finalContent },
                finish_reason: 'stop'
            }]
        };
    }

    /**
     * Optimized task-to-model routing map.
     */
    public static taskRouteMap: Record<string, string[]> = {
        [TaskType.Coding]: [
            'qwen/qwen3-coder-480b-a35b-instruct:free',
            'DeepSeek-R1',
            'gpt-oss-20b',
            'codestral-latest',
            '@cf/qwen/qwen2.5-coder-32b-instruct',
            '@cf/qwen/qwq-32b',
            'gemini-3.1-pro-preview',
            'deepseek-ai/DeepSeek-R1',
            'gemini-2.5-flash',
            'mistral-large-latest',
            'mistral-small-latest',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'glm-5.1',
            'glm-5-turbo',
            'glm-4.5-air',
        ],
        [TaskType.Moderation]: [
            'llama-3.3-70b-versatile',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'ministral-8b-latest',
            'mistral-small-latest',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'nvidia/nemotron-mini-4b-instruct',
            'glm-4.6',
            'glm-4.5-air',
            'llama3.1-8b',
        ],
        [TaskType.Classification]: [
            'llama-3.3-70b-versatile',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.5-flash',
            'glm-4.6',
            'glm-4.5-air',
            'gemini-2.0-flash',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'mistral-small-latest',
            'nvidia/nemotron-3-nano-30b-a3b:free',
        ],
        [TaskType.UserIntent]: [
            'gemini-3.1-flash-lite-preview',
            'llama-3.3-70b-versatile',
            'gemini-2.5-flash',
            'glm-4.6',
            'glm-4.5-air',
            'gemini-2.0-flash',
            'nvidia/nemotron-mini-4b-instruct',
            'mistral-small-latest',
        ],
        [TaskType.SemanticSearch]: [
            'command-r-plus-08-2024',
            'gemini-3.1-pro-preview',
            'arcee-ai/trinity-large-preview:free',
            'gemini-2.5-flash',
            'mistral-large-latest',
            'qwen/qwen3-next-80b-a3b-instruct:free',
            'openai/gpt-oss-120b:free',
            'gemini-2.5-pro',
            'llama-3.3-70b-versatile',
        ],
        [TaskType.Summarization]: [
            'command-a-03-2025',
            'mistralai/mistral-small-3.1-24b:free',
            'llama-3.3-70b-versatile',
            'gemini-2.5-flash',
            'gemini-3-flash-preview',
            'glm-4.7',
            'glm-4.5-air',
        ],
        [TaskType.EntityExtraction]: [
            'gemini-3.1-pro-preview',
            'llama-3.3-70b-versatile',
            'arcee-ai/trinity-large-preview:free',
            'command-r-plus-08-2024',
            'gemini-2.5-flash',
            'glm-4.7',
            'glm-4.5-air',
        ],
        [TaskType.Chat]: [
            'DeepSeek-R1',
            'gpt-oss-20b',
            'gpt-4o',
            'gemini-3.1-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.0-flash',
            'glm-5.1',
            'glm-5-turbo',
            'glm-4.7',
            'glm-4.6',
            'glm-4.5-air',
            'meta-llama/Llama-3.3-70B-Instruct',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'openrouter/free',
        ]
    };

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        // Step 0: Input validation
        if (!context.request.messages || context.request.messages.length === 0) {
            throw new Error('Message array is empty or undefined');
        }

        // Step 1: Independent Thinking - Analysis & Classification
        if (!context.taskType) {
            context.taskType = this.autoClassify(context.request.messages, context.keywords);
            console.debug(`[Router] Auto-classified task as: ${context.taskType}`);
        }

        // Step 2: Task Decomposition for complex inputs
        if (this.isComplex(context.request.messages)) {
            await this.decomposeAndExecute(context);
            if (context.response) return; // Terminal if handled by orchestrator
        }

        const taskType = context.taskType || TaskType.Chat;
        const requestedModel = context.request.model;
        const tierModels = (requestedModel && requestedModel !== 'any')
            ? [requestedModel, ...(IntelligentRouterMiddleware.taskRouteMap[taskType] || [])]
            : (IntelligentRouterMiddleware.taskRouteMap[taskType] || []);

        // Use Set to maintain order but remove duplicates
        const finalTierModels = [...new Set(tierModels)].filter(Boolean) as string[];

        const availableProviders = ProviderRegistry.getInstance().getAvailableProviders();
        if (availableProviders.length === 0) {
            throw new Error('No available providers. Please check your API keys.');
        }

        (context as any).providersAttempted = [];
        let lastError: Error | null = null;
        let primaryError: Error | null = null;
        const allErrors: string[] = [];

        // --- Context Management Strategic Workflow ---
        let originalTokens = context.estimatedTokens;
        if (originalTokens === undefined) {
            originalTokens = this.executor.calculateTokens(context.request.messages);
            context.estimatedTokens = originalTokens;
        }

        let estimatedTokens = originalTokens;
        let contextCompressed = false;

        // Level 1: Context Compression for complex prompts (> 4000 tokens) or imminent overflow
        const maxWindow = Math.max(...availableProviders.flatMap(p => p.models).map(m => m.contextWindow || 0));
        const absoluteOverflow = maxWindow > 0 && estimatedTokens > maxWindow;

        if (estimatedTokens > 4000 || absoluteOverflow) {
            const targetTokens = absoluteOverflow ? Math.min(estimatedTokens * 0.5, maxWindow * 0.8) : Math.max(2000, estimatedTokens * 0.4);
            const summarizer = async (text: string) => {
                // Use a stable summarization model
                const summaryPrompt = `Summarize precisely while preserving technical context: ${text}`;
                const preferredModels = IntelligentRouterMiddleware.taskRouteMap[TaskType.Summarization];

                // Try preferred models first
                for (const modelId of preferredModels) {
                    for (const p of availableProviders) {
                        if (p.models.some(m => m.id === modelId)) {
                            try {
                                const res = await p.chat({
                                    model: modelId,
                                    messages: [{ role: 'user', content: summaryPrompt }]
                                });
                                return res.choices[0].message.content;
                            } catch { continue; }
                        }
                    }
                }

                // Fallback: try ANY available provider with ANY model that has space
                for (const p of availableProviders) {
                    if (p.models.length > 0) {
                        const m = p.models[0];
                        try {
                            const res = await p.chat({
                                model: m.id,
                                messages: [{ role: 'user', content: summaryPrompt }]
                            });
                            return res.choices[0].message.content;
                        } catch { continue; }
                    }
                }

                throw new Error('All summarization providers failed.');
            };

            try {
                const compResult = await this.contextManager.compress(context, targetTokens, summarizer);
                context.request.messages = compResult.messages;
                estimatedTokens = this.executor.calculateTokens(context.request.messages);
                context.estimatedTokens = estimatedTokens;
                contextCompressed = true;
            } catch (err: any) {
                console.warn(`[Router][Tier1] Compression failed, falling back to Tier 2: ${err.message}`);
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

        const compressionRatio = originalTokens / estimatedTokens;
        const isHeavyPrompt = originalTokens > 8000 || compressionRatio > 2.0;

        // --- Post-Compression Routing Priority ---
        if (isHeavyPrompt) {
            // Sort by capability descending to ensure heavy prompts use strong models
            finalTierModels.sort((a, b) => {
                const ca = IntelligentRouterMiddleware.modelCapabilities[a] || 0.5;
                const cb = IntelligentRouterMiddleware.modelCapabilities[b] || 0.5;
                return cb - ca;
            });
        }

        // --- Fallback Execution Loop ---
        for (const modelId of finalTierModels) {
            const capability = IntelligentRouterMiddleware.modelCapabilities[modelId] || 0.5;

            // Adaptive Headroom: Powerhouses need more space for complex thoughts
            let requiredHeadroom = 0.1;
            if (isHeavyPrompt) {
                if (capability >= 0.9) requiredHeadroom = 0.25;
                else if (capability >= 0.7) requiredHeadroom = 0.15;
            }

            const scoredProviders = availableProviders
                .filter(p => p.models.some(m => m.id === modelId))
                .map(provider => {
                    const modelMetadata = provider.models.find(m => m.id === modelId);

                    // 1. Base Score from capability
                    let baseScore = capability;

                    // 2. Health and Weighting
                    const healthScore = provider.consecutiveFailures > 0 ? 0.3 : 1.0;
                    const penalty = provider.getPenaltyScore();
                    const usage = provider.getUsageStats();
                    const rpmLimit = provider.rateLimits.rpm || 60;
                    const loadFactor = Math.max(0.1, 1 - (usage.requestCountMinute / rpmLimit));

                    // 3. Token-aware load factor
                    let tokenFactor = 1.0;
                    const tracking = this.executor.getTokenState()[provider.id];
                    if (tracking && tracking.remainingTokens !== undefined && Number.isFinite(tracking.remainingTokens)) {
                        // Proportional to 50k tokens as a "healthy" baseline
                        tokenFactor = Math.min(1.2, Math.max(0.1, tracking.remainingTokens / 50000));
                    }

                    // 4. Metadata-driven refinement
                    let scoreModifier = 1.0;
                    if (modelMetadata && modelMetadata.contextWindow) {
                        // Add 10% safety margin to estimated tokens to account for tokenizer drift
                        const bufferedTokens = Math.ceil((estimatedTokens || 1024) * 1.1);
                        const actualHeadroom = (modelMetadata.contextWindow - bufferedTokens) / modelMetadata.contextWindow;

                        // Hard Block: If truly overloaded, skip immediately
                        const hardBlockThreshold = modelId === requestedModel ? 0 : 0.05;
                        if (actualHeadroom < hardBlockThreshold) {
                            return { provider: provider as any, score: -1 };
                        }

                        // Penalty for low headroom if NOT the requested model
                        if (actualHeadroom < requiredHeadroom && modelId !== requestedModel) {
                            scoreModifier = 0.1;
                        }

                        // Refine base score with headroom
                        baseScore = (capability * 0.6) + (Math.max(0, actualHeadroom) * 0.4);
                    }

                    // 5. Persistence bonus
                    if (context.providerId && provider.id === context.providerId) baseScore += 1000;

                    // Final Score calculation with robustness guards
                    let finalScore = (baseScore * healthScore * loadFactor * tokenFactor * scoreModifier) - penalty;

                    // NaN/Infinity Guard: Ensure scores are always valid numbers before filtering
                    if (!Number.isFinite(finalScore)) {
                        finalScore = -1; // Default to blocked for safety
                    }

                    return { provider: provider as any, score: finalScore };
                })
                .filter(p => p.score > -0.5) // Circuit Breaker: Block hard overloads (-1) or significant penalties
                .sort((a, b) => b.score - a.score);


            for (const { provider } of scoredProviders) {
                try {
                    (context as any).providersAttempted.push(`${provider.id}/${modelId}`);
                    const response = await this.executor.tryProvider(context, provider.id, modelId);

                    if (response) {
                        if (contextCompressed) (context as any).contextCompressed = true;
                        context.response = response;
                        context.providerId = provider.id;
                        context.request.model = modelId;

                        // SUCCESS: Single path execution call to next()
                        try {
                            await next();
                        } catch (nextErr) {
                            throw nextErr; // Bubble up next() errors, do NOT fallback to other LLMs
                        }
                        return;
                    }
                } catch (err: any) {
                    lastError = err;
                    if (context.providerId && provider.id === context.providerId && !primaryError) {
                        primaryError = err;
                    }
                    allErrors.push(`${provider.id}/${modelId}: ${err.message}`);
                    provider.recordFailure(err.status || 500);
                    continue; // Try next provider/model
                }
            }
        }

        // --- Emergency Fallback: Last Resort Deep Truncation ---
        const emergencyModels = ['gemini-2.0-flash', 'glm-4.5-air', 'llama-3.3-70b-versatile'];
        const emergencyTruncation = this.contextManager.truncateOldest(context.request.messages, 1500);
        context.request.messages = emergencyTruncation.messages;
        delete context.estimatedTokens;

        for (const modelId of emergencyModels) {
            const providers = availableProviders.filter(p => p.models.some(m => m.id === modelId));
            for (const p of providers) {
                try {
                    (context as any).providersAttempted.push(`EMERGENCY:${p.id}/${modelId}`);
                    const res = await this.executor.tryProvider(context, p.id, modelId);
                    if (res) {
                        (context as any).contextCompressed = true;
                        context.response = res;
                        context.providerId = p.id;
                        context.request.model = modelId;
                        await next();
                        return;
                    }
                } catch (err: any) {
                    allErrors.push(`EMERGENCY:${p.id}/${modelId}: ${err.message}`);
                    p.recordFailure(err.status || 500);
                }
            }
        }

        const mainError = primaryError || lastError;
        const errorSummary = allErrors.slice(-3).join('; ');
        throw new Error(this.renderRouterError(taskType, context, mainError, errorSummary));
    }

    private renderRouterError(taskType: string, context: PipelineContext, mainError: Error | null, errorSummary: string): string {
        const primary = context.providerId || 'auto';
        const failMessage = mainError?.message || 'No available providers';
        const attempts = (context as any).providersAttempted?.join(', ') || 'none';

        return `[Router] Exhausted all fallback models for task ${taskType}. ` +
            `Primary provider ${primary} failed: ${failMessage}. ` +
            `Attempts: ${attempts}. ` +
            `Recent errors: ${errorSummary}`;
    }
}
