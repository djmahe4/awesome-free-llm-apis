export interface ModelMetadata {
    capability: number;      // 0.0 to 1.0
    contextWindow: number;   // context window size in tokens
    isVision?: boolean;      // supports multimodal/image input
    isVisionOnly?: boolean;  // strictly for vision/multimodal, cannot handle general text tasks
    isCoder?: boolean;       // specialized for coding
    isReasoning?: boolean;   // specialized for reasoning (thinking)
}

export const MODEL_METADATA: Record<string, ModelMetadata> = {
    // Frontier Reasoning
    'deepseek/deepseek-r1': { capability: 1.0, contextWindow: 64000, isReasoning: true },
    'deepseek-ai/DeepSeek-R1': { capability: 1.0, contextWindow: 64000, isReasoning: true },
    'liquid/lfm2.5-1.2b-thinking:free': { capability: 0.88, contextWindow: 32000, isReasoning: true },
    'microsoft/phi-4-mini-reasoning': { capability: 0.78, contextWindow: 128000, isReasoning: true },

    // S-Tier Generalists
    'gemma-4-31b-it': { capability: 0.95, contextWindow: 150000, isVision: true },
    'google/gemma-4-31B-it': { capability: 0.95, contextWindow: 150000, isVision: true },
    'google/gemma-4-31b-it:free': { capability: 0.95, contextWindow: 150000, isVision: true },
    'zai-glm-4.7': { capability: 0.95, contextWindow: 128000 },
    'gemma-4-26b-a4b-it': { capability: 0.94, contextWindow: 150000, isVision: true },
    'google/gemma-4-26B-A4B-it': { capability: 0.94, contextWindow: 150000, isVision: true },
    'google/gemma-4-26b-a4b-it:free': { capability: 0.94, contextWindow: 150000, isVision: true },
    'gpt-oss-120b': { capability: 0.94, contextWindow: 128000 },
    'qwen3-235b': { capability: 0.92, contextWindow: 128000 },
    'DeepSeek-V3': { capability: 0.92, contextWindow: 128000 },
    'deepseek-ai/DeepSeek-V3': { capability: 0.92, contextWindow: 128000 },
    'glm-5.1': { capability: 0.90, contextWindow: 128000 },
    'glm-5-turbo': { capability: 0.90, contextWindow: 128000 },
    'glm-4.7': { capability: 0.90, contextWindow: 128000 },
    'command-r-plus-08-2024': { capability: 0.90, contextWindow: 128000, isVision: true },
    'openai/gpt-4o': { capability: 0.90, contextWindow: 128000, isVision: true },
    'minimax-m3': { capability: 0.90, contextWindow: 128000 },
    'gemma4:31b': { capability: 0.90, contextWindow: 150000 },
    'meta/llama-4-maverick-17b-128e-instruct-fp8': { capability: 0.90, contextWindow: 128000 },

    // Coder Models
    'qwen/qwen3-coder-480b-a35b:free': { capability: 0.96, contextWindow: 128000, isCoder: true },
    'qwen/qwen3-coder-480b-a35b-instruct': { capability: 0.96, contextWindow: 128000, isCoder: true },
    'qwen3-coder:480b': { capability: 0.88, contextWindow: 128000, isCoder: true },
    'qwen3-coder-next': { capability: 0.85, contextWindow: 128000, isCoder: true },
    'mistral-ai/codestral-2501': { capability: 0.84, contextWindow: 128000, isCoder: true },

    // A-Tier
    'qwen/qwen3-32b': { capability: 0.88, contextWindow: 128000 },
    'meta-llama/llama-4-scout-17b-16e-instruct': { capability: 0.88, contextWindow: 128000, isVision: true },
    'meta/llama-4-maverick-17b-128e-instruct': { capability: 0.88, contextWindow: 128000 },
    'microsoft/phi-4-multimodal-instruct': { capability: 0.88, contextWindow: 128000, isVision: true },
    'mistralai/mistral-nemotron': { capability: 0.88, contextWindow: 128000 },
    'google/gemma-3-27b-it': { capability: 0.88, contextWindow: 130000, isVision: true },
    'qwen/qwen3-next-80b-a3b-instruct:free': { capability: 0.88, contextWindow: 128000 },
    'openai/gpt-4o-mini': { capability: 0.85, contextWindow: 128000, isVision: true },
    'llama-3.3-70b-versatile': { capability: 0.85, contextWindow: 128000 },
    'meta-llama/Llama-3.3-70B-Instruct': { capability: 0.85, contextWindow: 128000 },
    'meta/llama-3.3-70b-instruct': { capability: 0.85, contextWindow: 128000 },
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { capability: 0.85, contextWindow: 128000 },
    'mistral-large-latest': { capability: 0.85, contextWindow: 128000 },
    'mistralai/mistral-large-3-675b-instruct-2512': { capability: 0.85, contextWindow: 128000 },
    'Qwen/Qwen2.5-72B-Instruct': { capability: 0.85, contextWindow: 128000 },
    'minimaxai/minimax-m2.7': { capability: 0.85, contextWindow: 128000 },
    'bytedance/seed-oss-36b-instruct': { capability: 0.85, contextWindow: 128000 },
    'nvidia/nemotron-nano-12b-v2-vl:free': { capability: 0.85, contextWindow: 128000, isVision: true },
    'minimax-m2.7': { capability: 0.87, contextWindow: 128000 },
    'kimi-k2.6': { capability: 0.88, contextWindow: 128000, isVision: true },
    'nemotron-3-super': { capability: 0.88, contextWindow: 128000 },
    'deepseek-v4-flash': { capability: 0.88, contextWindow: 128000 },
    'devstral-2:123b': { capability: 0.88, contextWindow: 128000 },
    'openai/gpt-4.1-mini': { capability: 0.86, contextWindow: 128000 },
    'openai/gpt-5-mini': { capability: 0.93, contextWindow: 128000 },
    'deepseek/deepseek-v3-0324': { capability: 0.95, contextWindow: 128000 },
    'minimax-m2.5': { capability: 0.85, contextWindow: 128000 },
    'gemma3:27b': { capability: 0.85, contextWindow: 130000 },

    // B-Tier & Specialized
    'mistral-small-latest': { capability: 0.82, contextWindow: 128000 },
    'gemini-3.1-flash-lite': { capability: 0.82, contextWindow: 150000, isVision: true },
    'stepfun-ai/step-3.5-flash': { capability: 0.82, contextWindow: 128000, isVision: true },
    'nvidia/nemotron-3-nano-30b-a3b:free': { capability: 0.82, contextWindow: 128000 },
    'command-a-03-2025': { capability: 0.80, contextWindow: 128000 },
    'c4ai-aya-expanse-32b': { capability: 0.80, contextWindow: 128000 },
    'google/gemma-3n-e4b-it': { capability: 0.80, contextWindow: 130000 },
    'google/gemma-3n-e2b-it': { capability: 0.80, contextWindow: 130000 },
    'llama-3.1-8b-instant': { capability: 0.75, contextWindow: 128000 },
    'openai/gpt-oss-20b:free': { capability: 0.75, contextWindow: 32000 },
    'glm-4.5-air': { capability: 0.75, contextWindow: 128000 },
    'z-ai/glm-4.5-air:free': { capability: 0.75, contextWindow: 128000 },
    'Qwen/Qwen3-8B': { capability: 0.70, contextWindow: 32000 },
    'nvidia/nemotron-mini-4b-instruct:free': { capability: 0.65, contextWindow: 32000 },
    'nvidia/nemotron-mini-4b-instruct': { capability: 0.65, contextWindow: 32000 },
    'nvidia/nemotron-nano-9b-v2:free': { capability: 0.65, contextWindow: 32000 },
    'gpt-oss:20b': { capability: 0.78, contextWindow: 32000 },
    'nemotron-3-ultra': { capability: 0.90, contextWindow: 128000 },
    'ministral-3:14b': { capability: 0.84, contextWindow: 128000 },
    'ministral-3:3b': { capability: 0.72, contextWindow: 32000 },
    'minimax-m2.1': { capability: 0.82, contextWindow: 128000 },
    'gemma3:4b': { capability: 0.75, contextWindow: 130000 },
    'gemma3:12b': { capability: 0.82, contextWindow: 130000 },
    'nemotron-3-nano:30b': { capability: 0.80, contextWindow: 32000 },
    'rnj-1:8b': { capability: 0.75, contextWindow: 32000 },
    'ministral-3:8b': { capability: 0.80, contextWindow: 128000 },
    'mistral-ai/mistral-small-2503': { capability: 0.82, contextWindow: 128000 },
    '@cf/meta/llama-3.2-11b-vision-instruct': { capability: 0.75, contextWindow: 128000, isVision: true },
    'meta/llama-3.2-90b-vision-instruct': { capability: 0.86, contextWindow: 128000, isVision: true },
    'meta/llama-3.2-11b-vision-instruct': { capability: 0.80, contextWindow: 128000, isVision: true }
};

/**
 * Get the capability score of a model, falling back to 0.5 if unknown
 */
export function getModelCapability(modelId: string): number {
    return MODEL_METADATA[modelId]?.capability ?? 0.5;
}

/**
 * Get the context window size of a model, falling back to 32000 if unknown
 */
export function getModelContextLimit(modelId: string): number {
    return MODEL_METADATA[modelId]?.contextWindow ?? 32000;
}

/**
 * Check if a model is a specialized reasoning model
 */
export function isReasoningModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isReasoning;
}

/**
 * Check if a model is a specialized coder model
 */
export function isCoderModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isCoder;
}

/**
 * Check if a model supports vision/multimodal input
 */
export function isVisionSupported(modelId: string): boolean {
    const meta = MODEL_METADATA[modelId];
    if (meta?.isVision !== undefined) {
        return meta.isVision;
    }
    const lower = modelId.toLowerCase();
    return lower.includes('gemini') || lower.includes('gpt-4o') || lower.includes('vl') || lower.includes('vision');
}

/**
 * Check if a model is strictly vision/multimodal only and cannot handle general text tasks
 */
export function isVisionOnlyModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isVisionOnly || modelId.toLowerCase().includes('ocr') || modelId.toLowerCase().includes('paligemma');
}
