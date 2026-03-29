import { ProviderRegistry } from '../../providers/registry.js';
import { TaskType } from '../middleware.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';

export class IntelligentRouterMiddleware implements Middleware {
    name = 'IntelligentRouterMiddleware';

    private taskRouteMap: Record<string, string[]> = {
        [TaskType.Coding]: [
            'deepseek-ai/DeepSeek-R1',
            'gemini-3.1-pro-preview',
            'qwen2.5-coder-32b-instruct',
            'DeepSeek-R1',
            'deepseek-r1',
            'qwen/qwen3-coder-480b-a35b-instruct:free'
        ],
        [TaskType.Moderation]: [
            'google/gemma-2-2b-it',
            'gemini-2.5-flash',
            'gemini-3.1-flash-lite-preview',
            'nvidia/nemotron-nano-9b-v2:free'
        ],
        [TaskType.Classification]: [
            'llama-4-scout-17b-16e-instruct',
            'mistralai/Mistral-7B-Instruct-v0.3',
            'glm-4-flash',
            'glm-4.5-flash',
            'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
            'ministral-8b-latest'
        ],
        [TaskType.UserIntent]: [
            'llama-4-scout-17b-16e-instruct',
            'glm-4-flash',
            'mistral-small-latest'
        ],
        [TaskType.SemanticSearch]: [
            'command-r-plus-08-2024',
            'Qwen/Qwen3-235B-A22B',
            'nvidia/nemotron-3-super:free',
            'arcee-ai/trinity-large-preview:free'
        ],
        [TaskType.Summarization]: [
            'llama-4-scout-17b-16e-instruct',
            'command-a-03-2025',
            'mistralai/mistral-small-3.1-24b:free',
            'gemini-3.1-flash-preview'
        ],
        [TaskType.EntityExtraction]: [
            'Qwen/Qwen3-235B-A22B',
            'command-r-plus-08-2024',
            'gemini-3.1-flash-lite-preview',
            'minimax/minimax-m2.5:free'
        ],
        [TaskType.Chat]: [
            'gpt-4o',
            'Llama-3.3-70B-Instruct',
            'gemini-2.5-flash',
            'deepseek-ai/DeepSeek-V3',
            'mistral-large-latest',
            'deepseek-v3.2',
            'kimi-k2.5',
            'liquid/lfm2.5-1.2b-thinking:free',
            'openai/gpt-oss-120b:free'
        ]
    };

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        let taskType = context.taskType;
        if (!taskType || !this.taskRouteMap[taskType as string]) {
            taskType = TaskType.Chat;
            context.taskType = taskType;
        }

        // Always start with the explicitly requested model, then fall back to tier
        const requestedModel = context.request.model;
        const tierModels = [...new Set([requestedModel, ...this.taskRouteMap[taskType as string]])].filter(Boolean);

        const registry = ProviderRegistry.getInstance();
        let lastError: Error | undefined;

        for (const modelId of tierModels) {
            // Find all providers that support this model and are available
            const availableProviders = registry.getAllProviders().filter(
                p => p.models.some(m => m.id === modelId) && p.isAvailable()
            );

            for (const provider of availableProviders) {
                try {
                    context.request.model = modelId;
                    context.providerId = provider.id;

                    await next(); // Pass to TokenManager and LLMExecution

                    // If we reach here without error and have a response, success.
                    if (context.response) {
                        return;
                    }
                } catch (error: any) {
                    lastError = error;
                    console.warn(`[Router] Model ${modelId} via ${provider.id} failed: ${error.message}. Cascading to next fallback.`);
                    // continue loop to next fallback
                }
            }
        }

        throw new Error(`[Router] Exhausted all fallback models for task ${taskType}. Last error: ${lastError?.message || 'No available providers'}`);
    }
}
