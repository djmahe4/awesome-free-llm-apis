import { ProviderRegistry } from '../../providers/registry.js';
import { TaskType } from '../middleware.js';
import type { Message, ChatResponse, Provider } from '../../providers/types.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';
import { ContextManager } from '../../utils/ContextManager.js';
import { getMessageContent, prependToMessageContent } from '../../utils/MessageUtils.js';
import { LLMExecutor } from '../../utils/LLMExecutor.js';
import { calculateModelWeightedMaxTokens } from '../../utils/model-tokens.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class IntelligentRouterMiddleware implements Middleware {
    name = 'IntelligentRouterMiddleware';

    private executor: LLMExecutor;
    private contextManager: ContextManager;

    // Model capability scores (0.0 to 1.0)
    private static readonly modelCapabilities: Record<string, number> = {
        // Frontier Reasoning (Benchmark)
        'deepseek/deepseek-r1': 1.0,
        'deepseek-ai/DeepSeek-R1': 1.0,

        // S-Tier Generalists (0.90 - 0.99)
        'gemma-4-31b-it': 0.95,
        'google/gemma-4-31B-it': 0.95,
        'google/gemma-4-31b-it:free': 0.95,
        'zai-glm-4.7': 0.95,
        'gemma-4-26b-a4b-it': 0.94,
        'google/gemma-4-26B-A4B-it': 0.94,
        'google/gemma-4-26b-a4b-it:free': 0.94,
        'gpt-oss-120b': 0.94,
        'qwen/qwen3-coder-480b-a35b:free': 0.96,
        'qwen/qwen3-coder-480b-a35b-instruct': 0.96,
        //'Qwen/Qwen3-235B-A22B-nim': 0.92,
        'qwen3-235b': 0.92,
        'DeepSeek-V3': 0.92,
        'deepseek-ai/DeepSeek-V3': 0.92,
        'glm-5.1': 0.90,
        'glm-5-turbo': 0.90,
        'glm-4.7': 0.90,
        'command-r-plus-08-2024': 0.90,
        'openai/gpt-4o': 0.90,

        // A-Tier (0.81 - 0.89)
        'qwen/qwen3-32b': 0.88,
        'meta-llama/llama-4-scout-17b-16e-instruct': 0.88,
        'meta/llama-4-maverick-17b-128e-instruct': 0.88,
        'microsoft/phi-4-multimodal-instruct': 0.88,
        'mistralai/mistral-nemotron': 0.88,
        'google/gemma-3-27b-it': 0.88,
        'liquid/lfm2.5-1.2b-thinking:free': 0.88,
        'qwen/qwen3-next-80b-a3b-instruct:free': 0.88,
        'openai/gpt-4o-mini': 0.85,
        'llama-3.3-70b-versatile': 0.85,
        'meta-llama/Llama-3.3-70B-Instruct': 0.85,
        'meta/llama-3.3-70b-instruct': 0.85,
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 0.85,
        'mistral-large-latest': 0.85,
        'mistralai/mistral-large-3-675b-instruct-2512': 0.85,
        'Qwen/Qwen2.5-72B-Instruct': 0.85,
        'minimaxai/minimax-m2.7': 0.85,
        'bytedance/seed-oss-36b-instruct': 0.85,
        'nvidia/nemotron-nano-12b-v2-vl:free': 0.85,
        'mistral-small-latest': 0.82,
        //'ministral-8b-2512': 0.82,
        'gemini-3.1-flash-lite': 0.82,
        'stepfun-ai/step-3.5-flash': 0.82,
        'nvidia/nemotron-3-nano-30b-a3b:free': 0.82,

        // B-Tier & Specialized (0.60 - 0.80)
        'command-a-03-2025': 0.80,
        'c4ai-aya-expanse-32b': 0.80,
        'google/gemma-3n-e4b-it': 0.80,
        //'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': 0.75,
        'llama-3.1-8b-instant': 0.75,
        'openai/gpt-oss-20b:free': 0.75,
        //'gpt-oss-20b': 0.75,
        'glm-4.5-air': 0.75,
        'z-ai/glm-4.5-air:free': 0.75,
        'google/gemma-3n-e2b-it': 0.80,
        'Qwen/Qwen3-8B': 0.70,
        'nvidia/nemotron-mini-4b-instruct:free': 0.65,
        'nvidia/nemotron-mini-4b-instruct': 0.65,
        'nvidia/nemotron-nano-9b-v2:free': 0.65,

        // NEW (v1.0.6)
        'gpt-oss:20b': 0.78,
        'nemotron-3-ultra': 0.90,
        'qwen3-coder:480b': 0.88,
        'minimax-m2.7': 0.87,
        'ministral-3:14b': 0.84,
        'gemma3:27b': 0.85,
        'qwen3-coder-next': 0.85,
        'ministral-3:3b': 0.72,
        'kimi-k2.6': 0.88,
        'minimax-m2.1': 0.82,
        'gemma3:4b': 0.75,
        'gemma3:12b': 0.82,
        'nemotron-3-super': 0.88,
        'deepseek-v4-flash': 0.88,
        'gpt-oss:120b': 0.86,
        'nemotron-3-nano:30b': 0.80,
        'gemma4:31b': 0.90,
        'rnj-1:8b': 0.75,
        'minimax-m3': 0.90,
        'minimax-m2.5': 0.85,
        'ministral-3:8b': 0.80,
        'devstral-2:123b': 0.88,
        'openai/gpt-4.1-mini':0.86,
        'openai/gpt-5-mini':0.93,
        'deepseek/deepseek-v3-0324':0.95,
        'meta/llama-4-maverick-17b-128e-instruct-fp8':0.90,
        'microsoft/phi-4-mini-reasoning':0.78,
        'mistral-ai/codestral-2501':0.84,
        'mistral-ai/mistral-small-2503':0.82,
    };

    constructor(executor?: LLMExecutor) {
        this.executor = executor || new LLMExecutor();
        this.contextManager = new ContextManager();
    }

    /**
     * Initializes the underlying persistence layer
     */
    async init(): Promise<void> {
        await (this.executor as any).init();
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
     * Get the executor instance for external access (e.g., dashboard stats)
     */
    public getExecutor(): LLMExecutor {
        return this.executor;
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
        // Reasoning
        'think': TaskType.Reasoning, 'thinking': TaskType.Reasoning, 'reason': TaskType.Reasoning,
        'logic': TaskType.Reasoning, 'proof': TaskType.Reasoning, 'math': TaskType.Reasoning,
    };

    /**
     * Automatically classifies the task type based on explicit keywords or prompt content.
     */
    private autoClassify(messages: Message[], explicitKeywords?: string[]): TaskType {
        // 1. Check for Vision task (images)
        for (const msg of messages) {
            if (Array.isArray(msg.content)) {
                if (msg.content.some(item => item && typeof item === 'object' && item.type === 'image_url')) {
                    return TaskType.Vision;
                }
            }
        }

        // 2. Prioritize Explicit Keywords (Majority Voting)
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

        // 3. Fallback to Message Content Analysis
        const lastMsg = getMessageContent(messages[messages.length - 1]).toLowerCase();

        // Specific Tasks First
        if (lastMsg.includes('classify') || lastMsg.includes('sentiment') || lastMsg.includes('categorize')) {
            return TaskType.Classification;
        }
        if (lastMsg.includes('moderate') || lastMsg.includes('safety') || lastMsg.includes('policy') || lastMsg.includes('violation')) {
            return TaskType.Moderation;
        }
        if (lastMsg.includes('summarize') || lastMsg.includes('summarization') || lastMsg.includes('tldr') || lastMsg.includes('tl;dr') || lastMsg.includes('concise')) {
            return TaskType.Summarization;
        }
        if (lastMsg.includes('extract') || lastMsg.includes('entities') || lastMsg.includes('json') || lastMsg.includes('fields')) {
            return TaskType.EntityExtraction;
        }
        if (lastMsg.includes('search') || lastMsg.includes('find') || lastMsg.includes('lookup')) {
            return TaskType.SemanticSearch;
        }
        if (lastMsg.includes('think') || lastMsg.includes('reason') || lastMsg.includes('logic') || lastMsg.includes('step by step')) {
            return TaskType.Reasoning;
        }
        if (lastMsg.includes('who are you') || lastMsg.includes('what can you do') || lastMsg.includes('help') || lastMsg.includes('capabilities')) {
            return TaskType.UserIntent;
        }

        // Coding last as it has some very common words like 'class' or 'debug'
        if (lastMsg.includes('```') || lastMsg.includes('function ') || lastMsg.includes('class ') || lastMsg.includes('debug') || lastMsg.includes('implement')) {
            return TaskType.Coding;
        }

        return TaskType.Chat;
    }

    /**
     * Detects if a prompt is complex enough to warrant decomposition.
     */
    private isComplex(messages: Message[]): boolean {
        const lastMsg = getMessageContent(messages[messages.length - 1]);
        const lower = lastMsg.toLowerCase();

        // 1. Numbered steps (e.g., "1. Do this, 2. Do that")
        const stepCount = (lastMsg.match(/^\s*\d+[.)]\s/gm) || []).length;
        
        // 2. Multiple questions (e.g., "How many...? What is...? When...?")
        const questionCount = (lastMsg.match(/\?/g) || []).length;
        
        // 3. Sequential logical markers (relaxed from requiring all three)
        const hasSequencers = (lower.includes('first') || lower.includes('start') || lower.includes('step')) &&
            (lower.includes('then') || lower.includes('next') || lower.includes('after') || lower.includes('subtask'));

        // 4. Presence of code blocks (code tasks are inherently complex)
        const hasCodeBlocks = lastMsg.includes('```');

        // 5. Prompts that are very long (likely contain detailed context or instructions)
        const isLong = lastMsg.length > 2500;

        return stepCount >= 3 || 
               (questionCount >= 3 && isLong) || 
               hasSequencers || 
               hasCodeBlocks ||
               (stepCount >= 2 && isLong);
    }

    /**
     * Decomposes a complex task into subtasks and executes them.
     */
    private async decomposeAndExecute(context: PipelineContext): Promise<void> {
        console.debug(`[Router] Decomposing complex task...`);

        // 1. Pick a Planner model (SiliconFlow V3, DeepSeek-R1, or Gemini Flash Lite)
        const plannerModels = context.request.google_search
            ? ['gemini-3.1-flash-lite', 'deepseek/deepseek-r1', 'deepseek-ai/DeepSeek-V3', 'qwen/qwen3-coder:free']
            : ['deepseek/deepseek-r1', 'deepseek-ai/DeepSeek-V3', 'gemini-3.1-flash-lite', 'qwen/qwen3-coder:free', 'llama-3.3-70b-versatile'];
        let plannerResponse: string | null = null;

        const lastMessage = context.request.messages.length > 0
            ? getMessageContent(context.request.messages[context.request.messages.length - 1])
            : 'No content provided';

        const planningPrompt = `Analyze this request and split it into a list of independent subtasks. 

### GROUNDING RULES:
1. USE ONLY the file paths and project structures explicitly mentioned in the "# FULL MEMORY STATE" or "# TASK CONTEXT" sections above.
2. DO NOT hallucinate or imagine files, directories, or external libraries that are not in the context.
3. If the user refers to a project that is NOT in the memory, your subtasks must first be to SEARCH and DISCOVER the structure, NOT to assume it.
4. Keep the list concise (max 8 subtasks).

Return ONLY a JSON array of strings, where each string is a clear subtask instruction.
Request: ${lastMessage}`;

        for (const modelId of plannerModels) {
            try {
                const res = await this.executor.prompt(
                    [{ role: 'user', content: planningPrompt }],
                    modelId,
                    {
                        google_search: context.request.google_search,
                        sessionId: context.request.sessionId,
                        agentic: context.request.agentic
                    }
                );
                plannerResponse = res.choices[0].message.content;
                if (plannerResponse) break;
            } catch (err) {
                console.error(`[Router] Planner ${modelId} failed:`, err);
                continue;
            }
        }

        if (!plannerResponse) {
            console.error(`[Router] All planners failed. Falling back to monolithic execution.`);
            return;
        }

        // Parse subtasks
        let subtasks: any[] = [];
        try {
            // Basic JSON extraction
            const jsonMatch = plannerResponse.match(/\[.*\]/s);
            const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : plannerResponse);
            subtasks = Array.isArray(parsed) ? parsed : [parsed];
        } catch (err) {
            console.error(`[Router] Failed to parse planner response:`, err);
            // Fallback: use lines if JSON fails
            subtasks = plannerResponse.split('\n').filter(l => l.trim().length > 5);
        }

        if (subtasks.length === 0) {
            console.error(`[Router] No subtasks parsed. Falling back to monolithic.`);
            return;
        }

        console.debug(`[Router] Executing ${subtasks.length} subtasks...`);
        const subtaskResults: string[] = [];

        for (const [i, task] of subtasks.entries()) {
            const taskStr = getMessageContent(task);
            const taskType = this.autoClassify([{ role: 'user', content: taskStr }], context.keywords);
            console.debug(`[Router] Subtask ${i + 1}: "${taskStr.slice(0, 50)}..." (Type: ${taskType})`);

            try {
                // Execute subtask with best model for its type
                const subtaskRes = await this.executor.prompt(
                    [...context.request.messages.slice(0, -1), { role: 'user', content: taskStr }],
                    'any', // Let executor pick best for type if it can, otherwise defaults to chat
                    {
                        taskType,
                        // Only the first iteration inherits search, or if the subtask specifically requires it
                        google_search: (i === 0 && context.request.google_search) || taskType === TaskType.SemanticSearch,
                        sessionId: context.sessionId,
                        agentic: context.request.agentic
                    }
                );
                subtaskResults.push(`### Subtask ${i + 1}: ${taskStr}\n${subtaskRes.choices[0].message.content}`);
            } catch (err) {
                console.error(`[Router] Subtask ${i + 1} failed:`, err);
                subtaskResults.push(`### Subtask ${i + 1}: ${taskStr}\nFAILED: ${err}`);
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
    public static taskRouteMap: Record<TaskType, string[]> = {
        [TaskType.Coding]: [
            'qwen/qwen3-coder-480b-a35b:free',
            'qwen/qwen3-coder-480b-a35b-instruct',
            'qwen/qwen3-coder:free',
            'deepseek-ai/deepseek-r1-distill-qwen-32b',
            'openai/gpt-oss-120b',
            'qwen/qwen3-32b',
            'zai-glm-4.7',
            'openai/gpt-5-mini',
            'google/gemma-4-26b-a4b-it:free',
            'google/gemma-4-31b-it:free',
            'google/gemma-4-31B-it',
            'google/gemma-4-26B-A4B-it',
            'gpt-oss-120b',
            'mistral-ai/codestral-2501',
            'deepseek/deepseek-r1',
            'meta/llama-4-maverick-17b-128e-instruct',
            'mistralai/mistral-large-3-675b-instruct-2512',
            'codestral-latest',
            '@cf/qwen/qwen2.5-coder-32b-instruct',
            '@cf/qwen/qwq-32b',
            //'gpt-oss-20b',
            'deepseek/deepseek-v3-0324',
            'gemini-3.1-flash-lite',
            'mistral-large-latest',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'glm-5.1',
            'glm-5-turbo',
            'z-ai/glm-4.5-air:free',
            'gemma-4-31b-it',                // Gemini Provider - 31B
            'gemma-4-26b-a4b-it',            // Gemini Provider - 26B
            'glm-4.5-air',
            'kilo-auto/free',
            'bytedance/seed-oss-36b-instruct',
            'microsoft/phi-4-multimodal-instruct',
            'mistralai/mistral-nemotron',
            'minimaxai/minimax-m2.7',
            'qwen3-235b',
            //'Qwen/Qwen3-235B-A22B-nim',
            'openai/gpt-4o',
            'qwen3-coder:480b',
            'qwen3-coder-next',
            'meta/llama-4-maverick-17b-128e-instruct-fp8',
            'devstral-small-2:24b',
            'devstral-2:123b',
            'openai/gpt-4.1-mini',
        ],
        [TaskType.Reasoning]: [
            'deepseek/deepseek-r1',
            'deepseek-ai/DeepSeek-R1',
            'deepseek-ai/deepseek-r1-distill-qwen-32b',
            'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
            'zai-glm-4.7',
            'liquid/lfm2.5-1.2b-thinking:free',
            'glm-5.1',
            'deepseek/deepseek-v3-0324',
            'openai/gpt-5-mini',
            'qwen/qwen3-coder:free',
            'google/gemma-4-26b-a4b-it:free',
            'google/gemma-4-31b-it:free',
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',                // Gemini Provider
            'gemma-4-26b-a4b-it',            // Gemini Provider
            'google/gemma-4-26B-A4B-it',
            'gpt-oss-120b',
            'openai/gpt-4o',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'mistralai/mistral-nemotron',
            'microsoft/phi-4-multimodal-instruct',
            'bytedance/seed-oss-36b-instruct',
            'minimaxai/minimax-m2.7',
            'qwen3-235b',
            //'Qwen/Qwen3-235B-A22B-nim',
            'glm-4.7',
            'microsoft/phi-4-mini-reasoning',
        ],
        [TaskType.Moderation]: [
            'llama-3.3-70b-versatile',
            'google/gemma-4-31b-it:free',
            'google/gemma-4-31B-it',
            'google/gemma-3-27b-it',
            'gemma-4-31b-it',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'gemini-3.1-flash-lite',
            'glm-4.5-air',
            'ministral-8b-latest',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'glm-4.6',
        ],
        [TaskType.Classification]: [
            'google/gemma-4-31b-it:free',
            'google/gemma-4-31B-it',
            'google/gemma-3-27b-it',
            'gemma-4-31b-it',
            'deepseek/deepseek-v3-0324',
            'llama-3.3-70b-versatile',
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, bulk classification
            //'ministral-8b-2512',
            //'GLM-4.6V-Flash',
            'openai/gpt-5-mini',
            'gemini-3.1-flash-lite',
            'mistral-small-latest',
            'glm-4.6',
            'glm-4.5-air',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'meta/llama-4-maverick-17b-128e-instruct-fp8',
            'nvidia/nemotron-3-nano-30b-a3b:free',
            'google/gemma-3n-e2b-it',
            'google/gemma-3n-e4b-it',
            'openai/gpt-4.1-mini',
            'microsoft/phi-4-mini-reasoning',
            'mistral-ai/mistral-small-2503',
        ],
        [TaskType.UserIntent]: [
            'google/gemma-4-31b-it:free',
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',
            'openai/gpt-5-mini',
            'mistral-small-latest',
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, bulk-friendly
            'gemini-3.1-flash-lite',
            'llama-3.3-70b-versatile',
            'glm-4.6',
            'glm-4.5-air',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'nvidia/nemotron-mini-4b-instruct:free',
            'nvidia/nemotron-mini-4b-instruct',
            'openai/gpt-4.1-mini',
            'deepseek/deepseek-v3-0324',
            'mistral-ai/mistral-small-2503',
        ],
        [TaskType.SemanticSearch]: [
            'nvidia/nemotron-3-super-120b-a12b:free',
            'arcee-ai/trinity-large-preview:free',
            'qwen/qwen3-next-80b-a3b-instruct:free',
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, great for bulk search
            'meta-llama/llama-4-scout-17b-16e-instruct',
            'command-r-plus-08-2024',
            'gemini-3.1-flash-lite',
            'mistral-large-latest',
            'openai/gpt-oss-120b:free',
            'llama-3.3-70b-versatile',
            'glm-4.5-air',
            'qwen3-235b',
            'openai/gpt-4o',
            //'Qwen/Qwen3-235B-A22B-nim',
            'openai/gpt-5-mini',
            'deepseek-v4-flash',
            'gemma4:31b',
            'openai/gpt-4.1-mini',
            'deepseek/deepseek-v3-0324',
        ],
        [TaskType.Summarization]: [
            'google/gemma-4-31b-it:free',
            'google/gemma-4-31B-it',
            'google/gemma-3-27b-it',
            'gemma-4-31b-it',
            'gpt-oss-120b',
            'mistral-small-latest',
            'gemini-3.1-flash-lite',
            'gemma-4-26b-a4b-it',
            'meta/llama-4-maverick-17b-128e-instruct-fp8',
            'mistralai/Mistral-7B-Instruct-v0.3', // HuggingFace capacity
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, great for bulk summarization
            'meta-llama/Llama-3.3-70B-Instruct',
            'command-a-03-2025',
            'openai/gpt-5-mini',
            'mistralai/mistral-small-3.1-24b:free',
            'glm-4.7',
            'glm-4.5-air',
            'microsoft/phi-4-mini-reasoning',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'openai/gpt-4.1-mini',
            'deepseek/deepseek-v3-0324',
            'mistral-ai/mistral-small-2503',
        ],
        [TaskType.EntityExtraction]: [
            'gpt-oss-120b',
            'google/gemma-4-31b-it:free',
            'gemma-4-31b-it',
            'google/gemma-4-31B-it',
            'arcee-ai/trinity-large-preview:free',
            'llama-3.3-70b-versatile',
            'mistral-ai/codestral-2501',
            'meta/llama-4-maverick-17b-128e-instruct-fp8',
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, bulk extraction
            'gemini-3.1-flash-lite',
            'glm-4.7',
            'glm-4.5-air',
            'openai/gpt-5-mini',
            'gemma-4-26b-a4b-it',
            'stepfun-ai/step-3.5-flash',
            'microsoft/phi-4-mini-reasoning',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'openai/gpt-4.1-mini',
            'deepseek/deepseek-v3-0324',
            'mistral-ai/mistral-small-2503'
        ],
        [TaskType.Chat]: [
            'deepseek/deepseek-r1',
            'deepseek-ai/DeepSeek-R1',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'google/gemma-4-31b-it:free',
            'google/gemma-4-26b-a4b-it:free',
            'openai/gpt-oss-20b:free',
            //'gpt-oss-20b',
            'meta/llama-3.3-70b-instruct',
            //'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
            'Qwen/Qwen2.5-72B-Instruct',
            'c4ai-aya-expanse-32b',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'openai/gpt-4o',
            'google/gemma-3n-e2b-it',
            'google/gemma-3n-e4b-it',
            'stepfun-ai/step-3.5-flash',
            'minimaxai/minimax-m2.7',
            'mistralai/mistral-nemotron',
            'bytedance/seed-oss-36b-instruct',
            'microsoft/phi-4-multimodal-instruct',
            'Qwen/Qwen3-8B',
            'arcee-ai/trinity-mini:free',
            'nvidia/nemotron-nano-12b-v2-vl:free',
            'nvidia/nemotron-nano-9b-v2:free',
            'openrouter/free',
            'llama-3.1-8b-instant',
            'gemini-3.1-flash-lite',
            'gemma-4-26b-a4b-it',
            'qwen3-235b',
            'microsoft/phi-4-mini-reasoning',
            //'Qwen/Qwen3-235B-A22B-nim',
            'openai/gpt-5-mini',
            'gpt-oss:20b',
            'gpt-oss:120b',
            'nemotron-3-nano:30b',
            'nemotron-3-super',
            'nemotron-3-ultra',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'kimi-k2.6',
            'minimax-m2.1',
            'minimax-m2.5',
            'minimax-m2.7',
            'minimax-m3',
            'ministral-3:3b',
            'ministral-3:8b',
            'ministral-3:14b',
            'meta/llama-4-maverick-17b-128e-instruct-fp8',
            'gemma3:4b',
            'gemma3:12b',
            'gemma3:27b',
            'gemma4:31b',
            'deepseek-v4-flash',
            'rnj-1:8b',
            'openai/gpt-4.1-mini',
            'deepseek/deepseek-v3-0324',
            'mistral-ai/mistral-small-2503'
        ],
        [TaskType.Vision]: [
            // Ranked by capability score — these mirror the top entries in imageModelCapabilities
            'nvidia/nemotron-nano-12b-v2-vl:free',       // OpenRouter
            'gemma-4-31b-it',                             // Google Gemini
            'gemma-4-26b-a4b-it',                         // Google Gemini
            'gemini-3.1-flash-lite',                      // Google Gemini
            'meta-llama/llama-4-maverick:free',           // OpenRouter
            'meta-llama/llama-4-scout:free',              // OpenRouter
            'meta/llama-3.2-90b-vision-instruct',         // NVIDIA NIM
            '@cf/meta/llama-4-scout-17b-16e-instruct',    // Cloudflare
            '@cf/google/gemma-4-26b-a4b-it',              // Cloudflare
            //'GLM-4.6V-Flash',
            'gpt-5.4-mini',
            'devstral-small-2:24b',
            'THUDM/GLM-4.1V-9B-Thinking',                // SiliconFlow
            'google/gemma-4-31b-it:free',                // OpenRouter fallback
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'meta/llama-3.2-90b-vision-instruct',
            'meta/llama-3.2-11b-vision-instruct',
            'meta/llama-4-scout-17b-16e-instruct',
            'microsoft/phi-4-multimodal-instruct',
            'gemma3:4b',
            'gemma3:12b',
            'gemma3:27b',
            'gemma4:31b',
            'ministral-3:3b',
            'ministral-3:8b',
            'ministral-3:14b',
            'devstral-small-2:24b',
            'devstral-2:123b',
            'glm-4.7',
        ]
    };

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        // Step 0: Input validation
        if (!context.request.messages || context.request.messages.length === 0) {
            throw new Error('Message array is empty or undefined');
        }

        // Step 1: Independent Thinking - Analysis & Classification
        const inferredType = this.autoClassify(context.request.messages, context.keywords);
        if (inferredType === TaskType.Vision || !context.taskType) {
            context.taskType = inferredType;
            console.debug(`[Router] task type set to: ${context.taskType}`);
        }

        // Auto-enable research for semantic search tasks
        if (context.taskType === TaskType.SemanticSearch && !context.request.google_search) {
            console.debug(`[Router] Enabling google_search for research task`);
            context.request.google_search = true;
        }

        // Step 2: Task Decomposition for complex inputs
        if (this.isComplex(context.request.messages)) {
            await this.decomposeAndExecute(context);
            if (context.response) return; // Terminal if handled by orchestrator
        }

        // Step 3: Adaptive Routing
        const taskType = context.taskType || TaskType.Chat;
        const requestedModel = context.request.model;
        const tierModels = (requestedModel && requestedModel !== 'any')
            ? [requestedModel, ...(IntelligentRouterMiddleware.taskRouteMap[taskType] || [])]
            : (IntelligentRouterMiddleware.taskRouteMap[taskType] || []);

        // Use Set to maintain order but remove duplicates
        let finalTierModels = [...new Set(tierModels)].filter(Boolean) as string[];

        const availableProviders = ProviderRegistry.getInstance().getAvailableProviders();
        if (availableProviders.length === 0) {
            throw new Error('No available providers. Please check your API keys.');
        }

        // For Chat task (default), we want to be inclusive of all registered models as a final fallback
        if (taskType === TaskType.Chat && finalTierModels.length < 100) {
             const allAvailable = availableProviders.flatMap(p => p.models.map(m => m.id));
             finalTierModels = [...new Set([...finalTierModels, ...allAvailable])];
        }

        if (context.request.google_search) {
            const geminiModels = finalTierModels.filter(m => m.toLowerCase().includes('gemini'));
            const otherModels = finalTierModels.filter(m => !m.toLowerCase().includes('gemini'));

            // Only force Gemini if at least one Gemini model is actually available (not cooling down)
            const geminiAvailable = availableProviders.some(p => p.id === 'gemini' && !this.executor.getProviderStats()['gemini']?.circuitOpen);

            if (geminiAvailable) {
                finalTierModels = [...geminiModels, ...otherModels];
                console.debug(`[Router] Prioritizing Gemini models for search: ${geminiModels.join(', ')}`);
            } else {
                console.debug(`[Router] Gemini cooling down. Using general fallback for search.`);
            }
        }

        (context as any).providersAttempted = [];
        let lastError: Error | null = null;
        let primaryError: Error | null = null;
        const allErrors: string[] = [];

        const startTime = Date.now();
        const totalBudget = context.request.timeoutMs || 60000;

        const getRemainingTimeout = () => {
            const elapsed = Date.now() - startTime;
            return Math.max(0, totalBudget - elapsed);
        };

        // --- Context Management Strategic Workflow ---
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
            const preferredModels = IntelligentRouterMiddleware.taskRouteMap[TaskType.Summarization];

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

        // Level 1: Context Compression for complex prompts (> 4000 tokens) or imminent overflow
        const maxWindow = Math.max(...availableProviders.flatMap(p => p.models).map(m => m.contextWindow || 0));
        const absoluteOverflow = maxWindow > 0 && estimatedTokens > maxWindow;

        if (estimatedTokens > 4000 || absoluteOverflow) {
            const targetTokens = absoluteOverflow ? Math.min(estimatedTokens * 0.5, maxWindow * 0.8) : Math.max(2000, estimatedTokens * 0.4);

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
            let requiredHeadroom = 1.1; // Default 10%
            if (isHeavyPrompt) {
                if (capability >= 0.9) requiredHeadroom = 1.25;
                else if (capability >= 0.7) requiredHeadroom = 1.15;
            }
            const requiredCapacity = estimatedTokens * requiredHeadroom;

            const scoredProviders = availableProviders
                .filter(p => p.models.some(m => m.id === modelId))
                .map(provider => {
                    const model = provider.models.find(m => m.id === modelId)!;
                return {
                        provider: provider as any,
                        score: this.calculateProviderScore(provider, modelId, capability, estimatedTokens, isHeavyPrompt, requestedModel, context)
                    };
                })
                .filter(p => p.score > -0.5)
                .sort((a, b) => b.score - a.score);


            const triedProviders = new Set<string>();
            let successfulResponse: ChatResponse | null = null;
            let successfulProviderId: string | null = null;
            let lastError: Error | null = null;
            let primaryError: Error | null = null;
            const allErrors: string[] = [];

            // --- Sequential Fallback Loop ---
            for (const { provider } of scoredProviders) {
                if (triedProviders.has(provider.id)) continue;
                triedProviders.add(provider.id);

                const stats = this.executor.getProviderStats()[provider.id];
                if (stats?.circuitOpen) {
                    console.error(`[Router][CircuitBreaker] Processing cooling-down provider ${provider.id} because it matched task requirements`);
                }

                const remainingTimeout = getRemainingTimeout();
                if (remainingTimeout < 2000) continue;

                const lowerModel = modelId.toLowerCase();
                const isReasoning = lowerModel.includes('deepseek') || lowerModel.includes('r1') || lowerModel.includes('o1') || lowerModel.includes('o3') || lowerModel.includes('gemini-pro') || lowerModel.includes('pro-preview');

                let perAttemptTimeout = Math.min(remainingTimeout, Math.max(12000, Math.floor(remainingTimeout / 2)));
                if (isReasoning) {
                    perAttemptTimeout = Math.min(remainingTimeout, Math.max(30000, Math.floor(remainingTimeout * 0.8)));
                }

                console.error(`[Router][Sequential] Launching ${provider.id}/${modelId} (budget: ${remainingTimeout}ms, attempt timeout: ${perAttemptTimeout}ms)`);
                (context as any).providersAttempted.push(`${provider.id}/${modelId}`);

                const attemptRequest = {
                    ...context.request,
                    model: modelId,
                };

                if (provider.id !== 'gemini') {
                    delete attemptRequest.google_search;
                }

                if (isReasoning) {
                    attemptRequest.max_tokens = Math.max(attemptRequest.max_tokens || 0, 8192);
                } else if (!attemptRequest.max_tokens) {
                    attemptRequest.max_tokens = calculateModelWeightedMaxTokens(modelId);
                }

                const precisionTasks: string[] = [TaskType.Coding, TaskType.EntityExtraction, TaskType.Classification];
                if (precisionTasks.includes(taskType)) {
                    attemptRequest.temperature = Math.min(attemptRequest.temperature ?? 0.7, 0.5);
                }

                try {
                    const tempContext = { ...context, request: attemptRequest };
                    const response = await this.executor.tryProvider(tempContext, provider.id, modelId, perAttemptTimeout);

                    if (response) {
                        successfulResponse = response;
                        successfulProviderId = provider.id;
                        if (contextCompressed) (context as any).contextCompressed = true;
                        break;
                    }
                } catch (err: any) {
                    lastError = err;
                    const errMsg = err.message?.toLowerCase() || '';
                    const isContextOverflow =
                        errMsg.includes('context_length_exceeded') ||
                        errMsg.includes('too many tokens') ||
                        errMsg.includes('string is too long') ||
                        (err.status === 400 && (errMsg.includes('context') || errMsg.includes('token') || errMsg.includes('length')));

                    if (isContextOverflow) {
                        console.error(`[Router][Overflow] Triggering dynamic compression due to error: ${err.message}`);
                        try {
                            const currentTokens = context.estimatedTokens || 4000;
                            const compResult = await this.contextManager.compress(context, currentTokens * 0.5, sharedSummarizer);
                            context.request.messages = compResult.messages;
                            context.estimatedTokens = this.executor.calculateTokens(context.request.messages);
                            contextCompressed = true;
                        } catch (compErr) {
                            console.error(`[Router][Overflow] Compression fallback failed: ${compErr}`);
                        }
                    }

                    if (context.providerId && provider.id === context.providerId && !primaryError) {
                        primaryError = err;
                    }
                    allErrors.push(`${provider.id}/${modelId}: ${err.message}`);
                    this.executor.recordProviderFailure(provider.id, err.status || 500);
                }
            }



            if (successfulResponse && successfulProviderId) {
                const res = successfulResponse as ChatResponse;
                // Clean response content (trim leading/trailing newlines/whitespace around brackets)
                if (res.choices && res.choices[0]?.message) {
                    const msg = res.choices[0].message as any;

                    // Concatenate thinking/reasoning if present (as requested: "THOUGHTS: ...")
                    const thoughts = (msg.thinking || msg.reasoning || '').toString().trim();
                    if (thoughts) {
                        prependToMessageContent(msg, `THOUGHTS: ${thoughts}\n\n`);
                        delete msg.thinking;
                        delete msg.reasoning;
                    }

                    if (typeof msg.content === 'string') {
                        msg.content = msg.content
                            .replace(/\n+(?=[{\[])/g, '') // Remove \n before { or [
                            .replace(/([}\]])\n+/g, '$1') // Remove \n after } or ]
                            .trim();
                    } else if (Array.isArray(msg.content)) {
                        msg.content.forEach((p: any) => {
                            if (p.text) {
                                p.text = p.text
                                    .replace(/\n+(?=[{\[])/g, '')
                                    .replace(/([}\]])\n+/g, '$1')
                                    .trim();
                            }
                        });
                    }
                }

                context.response = res;
                context.providerId = successfulProviderId;
                context.request.model = modelId;
                try {
                    await next();
                } catch (nextErr) {
                    throw nextErr;
                }
                return;
            }
        }

        // --- Emergency Fallback: Last Resort Deep Truncation ---
        const emergencyModels = ['gemini-3.1-flash-lite', 'google/gemma-4-31b-it', 'glm-4.5-air', 'llama-3.3-70b-versatile'];
        const emergencyTruncation = this.contextManager.truncateOldest(context.request.messages, 1500);
        context.request.messages = emergencyTruncation.messages;
        delete context.estimatedTokens;

        for (const modelId of emergencyModels) {
            const providers = availableProviders.filter(p => p.models.some(m => m.id === modelId));
            for (const p of providers) {
                try {
                    (context as any).providersAttempted.push(`EMERGENCY:${p.id}/${modelId}`);
                    context.request.model = modelId; // Update state before attempt
                    const res = await this.executor.tryProvider(context, p.id, modelId);
                    if (res) {
                        (context as any).contextCompressed = true;
context.response = res ?? undefined;
                        context.providerId = p.id;
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

    private calculateProviderScore(
        provider: Provider,
        modelId: string,
        capability: number,
        estimatedTokens: number,
        isHeavyPrompt: boolean,
        requestedModel: string | undefined,
        context: PipelineContext
    ): number {
        const model = provider.models.find(m => m.id === modelId);
        const stats = this.executor.getProviderStats()[provider.id];
        const tracking = this.executor.getTokenState()[provider.id];
        const now = Date.now();

        // 1. Base Score using capability and headroom
        let baseScore = capability;
        if (model?.contextWindow) {
            const bufferedTokens = Math.ceil(estimatedTokens * 1.1);
            const actualHeadroom = (model.contextWindow - bufferedTokens) / model.contextWindow;

            // Hard Block: If truly overloaded, skip immediately
            const hardBlockThreshold = modelId === requestedModel ? 0 : 0.05;
            if (actualHeadroom < hardBlockThreshold) {
                return -1;
            }

            // Refine base score with headroom
            baseScore = (capability * 0.6) + (Math.max(0, actualHeadroom) * 0.4);
        }

        // 2. Persistence bonus (favors sticking to same session)
        if (context.providerId && provider.id === context.providerId) {
            baseScore += 0.1;
        }

        // 3. Health Score (Circuit Breaker)
        const healthScore = stats?.circuitOpen ? 0.1 : 1.0;
        const penalty = stats?.circuitOpen ? 0.4 : 0;

        // 4. Token-aware load factor
        let tokenFactor = 1.0;
        if (tracking) {
            if (tracking.remainingTokens !== undefined && Number.isFinite(tracking.remainingTokens)) {
                const safetyBuffer = Math.max(1, estimatedTokens * 5);
                const loadFactor = tracking.remainingTokens / safetyBuffer;
                // Higher is better. Distinguish between 'good' and 'great' headroom.
                tokenFactor = Math.min(2.0, loadFactor > 1 ? 1.0 + Math.log10(loadFactor) * 0.2 : loadFactor);

                if (provider.id === 'huggingface' && tracking.remainingTokens < 5000) {
                    console.warn('[Router] Hugging Face credits may be low; prioritizing other free providers.');
                }
            }
        }

        // 5. Score Modifier (Headroom & Quota & HF preference)
        let scoreModifier = 1.0;
        if (model?.contextWindow) {
            const bufferedTokens = Math.ceil(estimatedTokens * 1.1);
            const actualHeadroom = (model.contextWindow - bufferedTokens) / model.contextWindow;

            // Required headroom based on capability
            let requiredHeadroom = 1.1; 
            if (isHeavyPrompt) {
                if (capability >= 0.9) requiredHeadroom = 1.25;
                else if (capability >= 0.7) requiredHeadroom = 1.15;
            }

            // Penalty for low headroom if NOT the requested model
            if (actualHeadroom < (requiredHeadroom - 1.0) && modelId !== requestedModel) {
                scoreModifier = 0.1;
            }
        }

        // Quota Depletion Hard-Penalty
        if (tracking && (tracking.remainingTokens === 0 || tracking.remainingRequests === 0)) {
            scoreModifier *= 0.05;
        }

        // Hugging Face preference
        if (provider.id === 'huggingface') {
            scoreModifier *= 0.7;
        }

        // 6. Success Momentum (favor providers that are working now)
        const lastSuccess = stats?.lastSuccessTime || 0;
        const recencyBonus = (now - lastSuccess) < 300000 ? 1.2 : 1.0;

        // 7. Preference for requested model
        let modelBonus = 0;
        if (requestedModel && modelId === requestedModel) {
            modelBonus = 0.3;
        }

        // Final Score calculation
        // Using tokenFactor as loadFactor as per user snippet context
        let finalScore = (baseScore * healthScore * tokenFactor * scoreModifier * recencyBonus) - penalty + modelBonus;

        // NaN/Infinity Guard: Ensure scores are always valid numbers before filtering
        if (!Number.isFinite(finalScore)) {
            return -1;
        }

        return finalScore;
    }

    /**
     * Renders a human-readable error message for routing failures.
     */
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

export class ImageRouterMiddleware implements Middleware {
    name = 'ImageRouterMiddleware';
    private executor: LLMExecutor;

    public static readonly imageModelCapabilities: Record<string, number> = {
        // Gemini
        'gemini-3.1-flash-lite': 0.85,
        'gemma-4-31b-it': 0.90,
        'gemma-4-26b-a4b-it': 0.88,

        // SiliconFlow
        'THUDM/GLM-4.1V-9B-Thinking': 0.88,
        'deepseek-ai/DeepSeek-OCR': 0.80,

        // Cloudflare
        '@cf/meta/llama-4-scout-17b-16e-instruct': 0.88,
        '@cf/google/gemma-3-12b-it': 0.82,
        '@cf/google/gemma-4-26b-a4b-it': 0.88,
        '@cf/moonshotai/kimi-k2.6': 0.88,
        '@cf/mistralai/mistral-small-3.1-24b-instruct': 0.85,
        '@cf/meta/llama-3.2-11b-vision-instruct': 0.75,

        // NVIDIA (phi-4-multimodal-instruct is working and preferred)
        'meta/llama-3.2-90b-vision-instruct': 0.86,
        'meta/llama-3.2-11b-vision-instruct': 0.80,
        'google/paligemma': 0.70,
        'microsoft/phi-4-multimodal-instruct': 0.85,

        // OpenRouter (prefer nemotron VL model — gemma-4-31b hits Google AI Studio rate limits on free tier)
        'nvidia/nemotron-nano-12b-v2-vl:free': 0.90,
        'meta-llama/llama-4-maverick:free': 0.88,
        'meta-llama/llama-4-scout:free': 0.87,
        'google/gemma-4-31b-it:free': 0.82,
        'google/gemma-4-26b-a4b-it:free': 0.80,
        'openrouter/free': 0.75,

        // Kilo Code (kilo-auto/free explicitly returns 404 for image input — no supported vision model yet)

        // LLM7
        //'GLM-4.6V-Flash': 0.90,
        'devstral-small-2:24b': 0.75,
        'gpt-5.4-mini':0.91,
        //'mistral-small-2506': 0.88,

        // Ollama Cloud / Hosted Registry
        'gemma4:31b': 0.92,
        'devstral-2:123b': 0.90,
        'glm-4.7': 0.88,
        'gemma4:27b': 0.86,
        'ministral-3:14b': 0.82,
        'gemma3:12b': 0.78,
        'gemma3:4b': 0.70,
        'ministral-3:8b': 0.72,
        'ministral-3:3b': 0.65
    };

    constructor(executor?: LLMExecutor) {
        this.executor = executor || new LLMExecutor();
    }

    private async processImageMessages(messages: any[]): Promise<any[]> {
        if (!messages || !Array.isArray(messages)) return messages;

        const processed: any[] = [];
        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                processed.push(await this.processStringContent(msg.content, msg));
            } else if (Array.isArray(msg.content)) {
                const newContent: any[] = [];
                for (const item of msg.content) {
                    if (item && typeof item === 'object' && item.type === 'image_url' && item.image_url?.url) {
                        const imgUrl = item.image_url.url;
                        if (imgUrl.startsWith('file:///')) {
                            const base64Url = await this.convertFileUrlToBase64(imgUrl);
                            if (base64Url) {
                                newContent.push({
                                    type: 'image_url',
                                    image_url: { url: base64Url }
                                });
                            } else {
                                newContent.push(item);
                            }
                        } else {
                            newContent.push(item);
                        }
                    } else {
                        newContent.push(item);
                    }
                }
                processed.push({ ...msg, content: newContent });
            } else {
                processed.push(msg);
            }
        }
        return processed;
    }

    private async processStringContent(content: string, msg: any): Promise<any> {
        const fileRegex = /file:\/\/\/\S+/g;
        const matches = [...content.matchAll(fileRegex)];

        if (matches.length === 0) {
            return msg;
        }

        const newContent: any[] = [];
        let lastIndex = 0;

        for (const match of matches) {
            const [fullMatch, fileUrl] = match;
            const matchIndex = match.index!;

            if (matchIndex > lastIndex) {
                newContent.push({ type: 'text', text: content.substring(lastIndex, matchIndex) });
            }

            const base64Url = await this.convertFileUrlToBase64(fileUrl);
            if (base64Url) {
                newContent.push({
                    type: 'image_url',
                    image_url: { url: base64Url }
                });
            } else {
                newContent.push({ type: 'text', text: fullMatch });
            }

            lastIndex = matchIndex + fullMatch.length;
        }

        if (lastIndex < content.length) {
            newContent.push({ type: 'text', text: content.substring(lastIndex) });
        }

        return { ...msg, content: newContent };
    }

    private async convertFileUrlToBase64(imgUrl: string): Promise<string | null> {
        let decodedPath = decodeURIComponent(imgUrl.replace(/^file:\/\//, ''));
        if (process.platform === 'win32' && decodedPath.startsWith('/') && /^\/[A-Za-z]:/.test(decodedPath)) {
            decodedPath = decodedPath.substring(1);
        }
        const imageFsPath = path.resolve(decodedPath);

        try {
            const buffer = await fs.readFile(imageFsPath);
            const ext = path.extname(imageFsPath).toLowerCase().replace('.', '');
            const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'];

            if (!ALLOWED_EXTENSIONS.includes(ext)) {
                console.warn(`[ImageRouterMiddleware] Unsupported image extension: .${ext}`);
                return null;
            }

            const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
            const base64Data = buffer.toString('base64');
            return `data:${mimeType};base64,${base64Data}`;
        } catch (err: any) {
            console.error(`[ImageRouterMiddleware] Error reading local image file ${imageFsPath}:`, err.message);
            return null;
        }
    }

    private hasImageContent(messages: any[]): boolean {
        if (!messages || !Array.isArray(messages)) return false;
        for (const msg of messages) {
            if (Array.isArray(msg.content)) {
                for (const item of msg.content) {
                    if (item && typeof item === 'object' && (item.type === 'image_url' || item.image_url)) {
                        return true;
                    }
                }
            } else if (typeof msg.content === 'string') {
                if (msg.content.includes('data:image/') || msg.content.includes('file:///')) {
                    return true;
                }
            }
        }
        return false;
    }

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        // Only intercept if there's image content in the messages
        if (!this.hasImageContent(context.request.messages)) {
            return await next();
        }

        console.debug('[ImageRouter] Intercepted vision request. Selecting vision models...');

        // Dynamic base64 image path resolution before forwarding to LLM execution
        context.request.messages = await this.processImageMessages(context.request.messages);

        // Standalone testing mode: resolve paths but skip routing overrides to allow direct targeting of individual models
        if (context.bypassImageRouter) {
            console.debug('[ImageRouter] Bypassing routing fallback selection because bypassImageRouter is active.');
            return await next();
        }

        const requestedModel = context.request.model;
        const availableProviders = ProviderRegistry.getInstance().getAvailableProviders();

        // Build candidate models from each provider's declared visionModels list
        const visionModelSet = new Set<string>();
        for (const provider of availableProviders) {
            if (provider.visionModels && provider.visionModels.length > 0) {
                for (const vm of provider.visionModels) {
                    visionModelSet.add(vm.id);
                }
            }
        }
        let candidateModels = Array.from(visionModelSet);

        // Prioritize requested model if it's a known vision model
        if (requestedModel && requestedModel !== 'any') {
            if (candidateModels.includes(requestedModel)) {
                candidateModels = [requestedModel, ...candidateModels.filter(m => m !== requestedModel)];
            } else {
                candidateModels = [requestedModel, ...candidateModels];
            }
        }

        // Sort candidates based on capability score descending
        candidateModels.sort((a, b) => {
            const scoreA = ImageRouterMiddleware.imageModelCapabilities[a] || 0.5;
            const scoreB = ImageRouterMiddleware.imageModelCapabilities[b] || 0.5;
            return scoreB - scoreA;
        });

        if (availableProviders.length === 0) {
            throw new Error('No available providers for vision routing.');
        }

        const startTime = Date.now();
        const totalBudget = context.request.timeoutMs || 60000;
        const getRemainingTimeout = () => {
            const elapsed = Date.now() - startTime;
            return Math.max(0, totalBudget - elapsed);
        };

        let lastError: Error | null = null;
        const triedModels: string[] = [];

        for (const modelId of candidateModels) {
            // Find providers that declare this model in their visionModels list
            const providersWithModel = availableProviders.filter(p =>
                (p.visionModels && p.visionModels.some(m => m.id === modelId)) ||
                p.models.some(m => m.id === modelId)
            );

            if (providersWithModel.length === 0) {
                continue;
            }

            triedModels.push(modelId);
            for (const provider of providersWithModel) {
                try {
                    const remainingTimeout = getRemainingTimeout();
                    if (remainingTimeout <= 1000) {
                        throw new Error('Timeout budget exhausted during vision fallback execution.');
                    }

                    console.debug(`[ImageRouter] Attempting vision model "${modelId}" on provider "${provider.name}"...`);

                    const res = await this.executor.tryProvider(
                        context,
                        provider.id,
                        modelId,
                        remainingTimeout
                    );

                     console.debug(`[ImageRouter] Successfully executed vision task using "${modelId}" via "${provider.name}".`);
                     context.response = res ?? undefined;
                     return; // Successful routing!
                } catch (err: any) {
                    console.error(`[ImageRouter] Model "${modelId}" on "${provider.name}" failed: ${err.message}`);
                    lastError = err;
                }
            }
        }

        throw new Error(`[ImageRouter] Failed to execute vision request on any available vision model. Tried models: ${triedModels.join(', ')}. Last error: ${lastError?.message}`);
    }
}

