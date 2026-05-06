import { ProviderRegistry } from '../../providers/registry.js';
import { TaskType } from '../middleware.js';
import type { Message, ChatResponse } from '../../providers/types.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';
import { ContextManager } from '../../utils/ContextManager.js';
import { getMessageContent, prependToMessageContent } from '../../utils/MessageUtils.js';
import { LLMExecutor } from '../../utils/LLMExecutor.js';

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
        'deepseek-v3.2': 0.95,
        'gemini-3.1-flash-lite-preview': 0.82,
        //'gemini-2.5-pro': 0.9,
        'command-r-plus-08-2024': 0.9,
        'command-a-03-2025': 0.8,
        'mistral-large-latest': 0.85,
        'mistralai/mistral-large-2-instruct': 0.85,
        'llama-3.3-70b-versatile': 0.85,
        'qwen/qwen3-coder:free': 0.94,
        'qwen/qwen3-coder-480b-a35b:free': 0.96,
        'qwen/qwen3-next-80b-a3b-instruct:free': 0.89,
        'google/gemma-4-26b-a4b-it:free': 0.95,
        'google/gemma-4-31B-it': 0.91,
        'openai/gpt-oss-120b': 0.92,
        'openai/gpt-oss-120b:free': 0.90,
        'openai/gpt-oss-20b:free': 0.75,
        'gpt-oss-20b': 0.75,
        'glm-5.1': 0.95,
        'glm-5-turbo': 0.9,
        'glm-4.7': 0.85,
        'glm-4.6': 0.8,
        'GLM-4.6V-Flash': 0.82,
        'glm-4.5-air': 0.7,
        'Qwen/Qwen2.5-72B-Instruct': 0.85,
        'Qwen/Qwen3-8B': 0.7,
        'qwen/qwen3-32b': 0.88,
        'qwen-3-235b-a22b-instruct-2507': 0.93,
        'Qwen/Qwen3-235B-A22B': 0.91,
        'qwen3.5': 0.92,
        'kimi-k2.5': 0.90,
        'meta/llama-3.3-70b-instruct': 0.85,
        'Llama-3.3-70B-Instruct': 0.85,
        'meta-llama/Llama-3.3-70B-Instruct': 0.85,
        'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': 0.75,
        'llama-3.1-8b-instant': 0.72,
        'ministral-8b-2512': 0.82,
        'meta-llama/llama-4-scout-17b-16e-instruct': 0.88,
        'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8': 0.87,
        'c4ai-aya-expanse-32b': 0.8,
        'z-ai/glm-4.5-air:free': 0.8,
        'liquid/lfm2.5-1.2b-thinking:free': 0.88,
        'nvidia/nemotron-3-super-120b-a12b:free': 0.93,
        'nvidia/nemotron-nano-12b-v2-vl:free': 0.85,
        'nvidia/nemotron-3-nano-30b-a3b:free': 0.82,
        'nvidia/nemotron-mini-4b-instruct:free': 0.65,
        'nvidia/nemotron-mini-4b-instruct': 0.65,
        'nvidia/nemotron-nano-9b-v2:free': 0.65,
        'mistral-small-latest': 0.82,
        'gpt-4o': 0.9,
        'arcee-ai/trinity-large-preview:free': 0.8,
        'arcee-ai/trinity-mini:free': 0.75,
        'openrouter/free': 0.75,
        'kilo-auto/free': 0.78,
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 0.85,
        '@cf/qwen/qwq-32b': 0.85,
        '@cf/qwen/qwen2.5-coder-32b-instruct': 0.82,
        'deepseek-ai/deepseek-r1-distill-qwen-32b': 0.93,
        'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B': 0.84,
        'gemma-3-1b-it': 0.75,
        'gemma-3-4b-it': 0.82,
        'gemma-3-12b-it': 0.88,
        'gemma-3-27b-it': 0.92,
        'gemma-3-2b-it': 0.78,
        'gemma-4-26b-it': 0.94,
        'gemma-4-31b-it': 0.95,
        // NVIDIA NIM — 40 RPM, highly capable
        'Qwen/Qwen3-235B-A22B-nim': 0.93,   // alias used by nvidia provider
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

        // Complex if it has significant numbered steps (ignore short lists), 
        // multiple distinct questions, or strong sequential signals.
        const stepCount = (lastMsg.match(/^\s*\d+[.)]\s/gm) || []).length;
        const questionCount = (lastMsg.match(/\?/g) || []).length;
        const hasSequencers = (lower.includes('first') || lower.includes('initial')) &&
            (lower.includes('then') || lower.includes('secondary')) &&
            (lower.includes('finally') || lower.includes('lastly'));
        const isLong = lastMsg.length > 2500;

        return stepCount >= 5 || (questionCount >= 3 && isLong) || hasSequencers;
    }

    /**
     * Decomposes a complex task into subtasks and executes them.
     */
    private async decomposeAndExecute(context: PipelineContext): Promise<void> {
        console.debug(`[Router] Decomposing complex task...`);

        // 1. Pick a Planner model (SiliconFlow V3, DeepSeek-R1, or Gemini Flash Lite)
        const plannerModels = context.request.google_search
            ? ['gemini-3.1-flash-lite-preview', 'DeepSeek-R1', 'deepseek-ai/DeepSeek-V3', 'qwen/qwen3-coder:free']
            : ['DeepSeek-R1', 'deepseek-ai/DeepSeek-V3', 'gemini-3.1-flash-lite-preview', 'qwen/qwen3-coder:free', 'llama-3.3-70b-versatile'];
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
            'qwen/qwen3-coder:free',
            'deepseek-ai/deepseek-r1-distill-qwen-32b',
            'openai/gpt-oss-120b',
            'qwen/qwen3-32b',
            'google/gemma-4-26b-a4b-it:free',
            'google/gemma-4-31B-it',
            'DeepSeek-R1',
            'Qwen/Qwen3-235B-A22B',      // NVIDIA NIM — 40 RPM, powerful coder
            'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
            'qwen-3-235b-a22b-instruct-2507',
            'codestral-latest',
            '@cf/qwen/qwen2.5-coder-32b-instruct',
            '@cf/qwen/qwq-32b',
            'deepseek-v3.2',
            'gpt-oss-20b',
            'gemini-3.1-flash-lite-preview',
            'mistral-large-latest',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'glm-5.1',
            'glm-5-turbo',
            'z-ai/glm-4.5-air:free',
            'google/gemma-3-27b-it',
            'gemma-4-31b-it',                // Gemini Provider - 31B
            'gemma-4-26b-it',                // Gemini Provider - 26B
            'glm-4.5-air',
            'kilo-auto/free',
        ],
        [TaskType.Reasoning]: [
            'DeepSeek-R1',
            'deepseek-ai/DeepSeek-R1',
            'deepseek-ai/deepseek-r1-distill-qwen-32b',
            'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
            'Qwen/Qwen3-235B-A22B',          // NVIDIA NIM — 40 RPM, reasoning powerhouse
            'liquid/lfm2.5-1.2b-thinking:free',
            'qwen-3-235b-a22b-instruct-2507',
            'glm-5.1',
            'qwen/qwen3-coder:free',
            'google/gemma-4-26b-a4b-it:free',
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',                // Gemini Provider
            'gemma-4-26b-it',                // Gemini Provider
            'nvidia/nemotron-3-super-120b-a12b:free',
        ],
        [TaskType.Moderation]: [
            'llama-3.3-70b-versatile',
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',
            'gemma-3-1b-it',                 // Fast safety/moderation
            'gemma-3-2b-it',
            'gemma-3-4b-it',
            'gemma-3-12b-it',                // Gemini Gemma 12B — lightweight, fast
            'gemma-3-27b-it',                // Gemini Gemma 27B — better accuracy
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'gemini-3.1-flash-lite-preview',
            'glm-4.5-air',
            'ministral-8b-latest',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'glm-4.6',
            'llama3.1-8b',
        ],
        [TaskType.Classification]: [
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',
            'llama-3.3-70b-versatile',
            'gemma-3-1b-it',                 // Tiny, perfect for classification
            'gemma-3-2b-it',
            'gemma-3-4b-it',
            'gemma-3-12b-it',                // Gemini Gemma 12B — ideal for classification
            'gemma-3-27b-it',                // Gemini Gemma 27B
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, bulk classification
            'ministral-8b-2512',
            'GLM-4.6V-Flash',
            'gemini-3.1-flash-lite-preview',
            'mistral-small-latest',
            'glm-4.6',
            'glm-4.5-air',
            'nvidia/nemotron-3-nano-30b-a3b:free',
        ],
        [TaskType.UserIntent]: [
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',
            'mistral-small-latest',
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, bulk-friendly
            'gemini-3.1-flash-lite-preview',
            'llama-3.3-70b-versatile',
            'glm-4.6',
            'glm-4.5-air',
            'nvidia/nemotron-mini-4b-instruct:free',
            'nvidia/nemotron-mini-4b-instruct',
        ],
        [TaskType.SemanticSearch]: [
            'nvidia/nemotron-3-super-120b-a12b:free',
            'qwen-3-235b-a22b-instruct-2507',
            'arcee-ai/trinity-large-preview:free',
            'qwen/qwen3-next-80b-a3b-instruct:free',
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, great for bulk search
            'meta-llama/llama-4-scout-17b-16e-instruct',
            'command-r-plus-08-2024',
            'gemini-3.1-flash-lite-preview',
            'mistral-large-latest',
            'openai/gpt-oss-120b:free',
            'llama-3.3-70b-versatile',
            'glm-4.5-air',
        ],
        [TaskType.Summarization]: [
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',
            'kimi-k2.5',
            'mistral-small-latest',
            'gemini-3.1-flash-lite-preview',
            'gemma-3-27b-it',
            'gemma-4-26b-it',
            'mistralai/Mistral-7B-Instruct-v0.3', // HuggingFace capacity
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, great for bulk summarization
            'meta-llama/Llama-3.3-70B-Instruct',
            'command-a-03-2025',
            'mistralai/mistral-small-3.1-24b:free',
            'glm-4.7',
            'glm-4.5-air',
        ],
        [TaskType.EntityExtraction]: [
            'google/gemma-4-31B-it',
            'gemma-4-31b-it',
            'arcee-ai/trinity-large-preview:free',
            'llama-3.3-70b-versatile',
            'Qwen/Qwen2.5-72B-Instruct',    // SiliconFlow — 1000 RPM, bulk extraction
            'gemini-3.1-flash-lite-preview',
            'glm-4.7',
            'glm-4.5-air',
            'google/gemma-3-27b-it',
        ],
        [TaskType.Chat]: [
            'DeepSeek-R1',
            'deepseek-ai/DeepSeek-R1',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'qwen3.5',
            'Qwen/Qwen3-235B-A22B',
            'qwen-3-235b-a22b-instruct-2507',
            'google/gemma-4-31B-it',
            'google/gemma-4-26b-a4b-it:free',
            'openai/gpt-oss-20b:free',
            'gpt-oss-20b',
            'Llama-3.3-70B-Instruct',
            'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
            'Qwen/Qwen2.5-72B-Instruct',
            'c4ai-aya-expanse-32b',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'meta/llama-3.3-70b-instruct',
            'mistralai/mistral-large-2-instruct',
            'gpt-4o',
            'Qwen/Qwen3-8B',
            'arcee-ai/trinity-mini:free',
            'nvidia/nemotron-nano-12b-v2-vl:free',
            'nvidia/nemotron-nano-9b-v2:free',
            'openrouter/free',
            'llama-3.1-8b-instant',
            'gemini-3.1-flash-lite-preview',
            'google/gemma-3-27b-it',
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
        const originalTokens = context.estimatedTokens ?? this.executor.calculateTokens(context.request.messages);
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
                    const stats = this.executor.getProviderStats()[provider.id];
                    const isCoolingDown = stats?.circuitOpen;
                    const healthScore = stats?.errors > 0 ? 0.3 : 1.0;
                    const penalty = isCoolingDown ? 0.5 : (stats?.errors > 0 ? Math.min(0.4, stats.errors * 0.1) : 0);

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

                    // 5. Persistence bonus (favors sticking to same session)
                    if (context.providerId && provider.id === context.providerId) baseScore += 1000;

                    // 6. Quota Depletion Hard-Penalty
                    if (tracking && (tracking.remainingTokens === 0 || tracking.remainingRequests === 0)) {
                        scoreModifier *= 0.05; // Drop to bottom of stack but keep as absolute last resort
                    }

                    // 7. Success Momentum (favor providers that are working now)
                    const lastSuccess = stats?.lastSuccessTime || 0;
                    const recencyBonus = (Date.now() - lastSuccess) < 300000 ? 1.2 : 1.0; // 20% bonus if succeeded in last 5m

                    // Final Score calculation with robustness guards
                    let finalScore = (baseScore * healthScore * loadFactor * tokenFactor * scoreModifier * recencyBonus) - penalty;


                    // NaN/Infinity Guard: Ensure scores are always valid numbers before filtering
                    if (!Number.isFinite(finalScore)) {
                        finalScore = -1; // Default to blocked for safety
                    }

                    return { provider: provider as any, score: finalScore };
                })
                .filter(p => p.score > -0.5)
                .sort((a, b) => b.score - a.score);

            const triedProviders = new Set<string>();
            let successfulResponse: ChatResponse | null = null;
            let successfulProviderId: string | null = null;
            let lastError: Error | null = null;

            const globalAbortController = new AbortController();
            const attemptPromises: Promise<void>[] = [];

            let index = 0;
            while (index < scoredProviders.length) {
                if (globalAbortController.signal.aborted) break;

                const { provider } = scoredProviders[index];
                index++;

                // Google Search is Gemini-exclusive, but we allow fallback to other providers (stripping search) if needed
                // if (context.request.google_search && provider.id !== 'gemini') continue;

                const stats = this.executor.getProviderStats()[provider.id];
                if (stats?.circuitOpen) {
                    console.error(`[Router][CircuitBreaker] Processing cooling-down provider ${provider.id} because it matched task requirements (Score: penalty -0.5 apply)`);
                }

                if (triedProviders.has(provider.id)) continue;
                triedProviders.add(provider.id);

                const remainingTimeout = getRemainingTimeout();
                if (remainingTimeout < 2000) continue;

                // Adaptive Timeout Floor
                const perAttemptTimeout = Math.min(remainingTimeout, Math.max(12000, Math.floor(remainingTimeout / 2)));

                const lowerModel = modelId.toLowerCase();
                const isReasoning = lowerModel.includes('deepseek') || lowerModel.includes('r1') || lowerModel.includes('o1') || lowerModel.includes('o3') || lowerModel.includes('gemini-pro') || lowerModel.includes('pro-preview');
                const hedgeDelay = isReasoning ? 20000 : 4000;

                console.error(`[Router][Hedge] Launching ${provider.id}/${modelId} (budget: ${remainingTimeout}ms, attempt timeout: ${perAttemptTimeout}ms, hedge: ${hedgeDelay}ms)`);
                (context as any).providersAttempted.push(`${provider.id}/${modelId}`);

                // Clone request for thread safety
                const attemptRequest = {
                    ...context.request,
                    model: modelId,
                    abortSignal: globalAbortController.signal
                };

                // Strip google_search if provider is not Gemini to prevent 400 Bad Request
                if (provider.id !== 'gemini') {
                    delete attemptRequest.google_search;
                }


                // Strip google_search if provider is not Gemini to prevent 400 errors
                // if (attemptRequest.google_search && provider.id !== 'gemini') {
                //     delete attemptRequest.google_search;
                // }

                // Boost tokens for reasoning models
                if (isReasoning) {
                    attemptRequest.max_tokens = Math.max(attemptRequest.max_tokens || 0, 8192);
                }

                // Temperature pinning: Cap at 0.5 for precision-critical task types.
                // Coding, extraction, and classification require factual/structural accuracy —
                // higher temperatures increase creative drift and hallucination risk.
                const precisionTasks: string[] = [TaskType.Coding, TaskType.EntityExtraction, TaskType.Classification];
                if (precisionTasks.includes(taskType)) {
                    attemptRequest.temperature = Math.min(attemptRequest.temperature ?? 0.7, 0.5);
                }

                const attemptPromise = (async () => {
                    try {
                        const tempContext = { ...context, request: attemptRequest };
                        const response = await this.executor.tryProvider(tempContext, provider.id, modelId, perAttemptTimeout);

                        if (response && !globalAbortController.signal.aborted) {
                            globalAbortController.abort(); // Cancel other parallel attempts
                            successfulResponse = response;
                            successfulProviderId = provider.id;
                            if (contextCompressed) (context as any).contextCompressed = true;
                        }
                    } catch (err: any) {
                        if (globalAbortController.signal.aborted) return; // Silent suppression of aborted fetch errors

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
                        // Use centralized executor to record failures to sync with persistent telemetry
                        this.executor.recordProviderFailure(provider.id, err.status || 500);
                    }
                })();

                attemptPromises.push(attemptPromise);

                if (globalAbortController.signal.aborted) break;

                // Hedged wait: Proceed to the next provider if this one doesn't finish within 'hedgeDelay'
                const timerPromise = new Promise<void>(resolve => setTimeout(resolve, hedgeDelay));
                await Promise.race([attemptPromise, timerPromise]);

                if (globalAbortController.signal.aborted) break;
            }

            // Sync tail of parallel executions
            await Promise.all(attemptPromises);

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
        const emergencyModels = ['gemini-3.1-flash-lite-preview', 'google/gemma-4-31b-it', 'glm-4.5-air', 'llama-3.3-70b-versatile'];
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
                        context.response = res;
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
