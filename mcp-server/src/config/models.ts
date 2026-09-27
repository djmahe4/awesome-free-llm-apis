export interface ModelMetadata {
    capability: number;      // 0.0 to 1.0
    contextWindow: number;   // context window size in tokens
    isVision?: boolean;      // supports multimodal/image input (image understanding)
    isVisionOnly?: boolean;  // strictly for vision/multimodal, cannot handle general text tasks
    isImageGeneration?: boolean; // T2I image generation / diffusion model
    isAudio?: boolean;       // TTS / speech synthesis
    isVideo?: boolean;       // T2V / motion video generation
    isCoder?: boolean;       // specialized for coding
    isReasoning?: boolean;   // specialized for reasoning (thinking)
    isRoleplaying?: boolean; // specialized for roleplaying and storytelling (accessible only for movie_tool)
}

export const MODEL_METADATA: Record<string, ModelMetadata> = {
    // Frontier Reasoning
    'deepseek-ai/DeepSeek-R1': { capability: 1.0, contextWindow: 64000, isReasoning: true },
    'liquid/lfm2.5-1.2b-thinking:free': { capability: 0.88, contextWindow: 32000, isReasoning: true },
    'microsoft/phi-4': { capability: 0.86, contextWindow: 128000, isReasoning: true },
    'empero-ai/Qwythos-9B-Claude-Mythos-5-1M': { capability: 0.95, contextWindow: 128000 },

    // S-Tier Generalists
    'gemma-4-31b-it': { capability: 0.95, contextWindow: 300000, isVision: true, isReasoning: true },
    'google/gemma-4-31b-it': { capability: 0.95, contextWindow: 300000, isVision: true, isReasoning: true },
    'google/gemma-4-31B-it': { capability: 0.95, contextWindow: 300000, isVision: true },
    'google/gemma-4-31b-it:free': { capability: 0.95, contextWindow: 300000, isVision: true },
    'gemma-4-26b-a4b-it': { capability: 0.94, contextWindow: 150000, isVision: true },
    'google/gemma-4-26B-A4B-it': { capability: 0.94, contextWindow: 150000, isVision: true },
    'google/gemma-4-26b-a4b-it:free': { capability: 0.94, contextWindow: 150000, isVision: true },
    'openai/gpt-oss-120b': { capability: 0.94, contextWindow: 128000 },
    'gpt-oss:120b': { capability: 0.94, contextWindow: 128000 },
    'deepseek-ai/DeepSeek-V3': { capability: 0.92, contextWindow: 128000 },
    'command-r-plus-08-2024': { capability: 0.90, contextWindow: 128000 },
    'command-a-03-2025': { capability: 0.88, contextWindow: 128000 },
    'command-a-plus-05-2026': { capability: 0.92, contextWindow: 128000, isVision: true },
    'command-a-reasoning-08-2025': { capability: 0.90, contextWindow: 128000, isReasoning: true },
    'c4ai-aya-vision-32b': { capability: 0.88, contextWindow: 128000, isVision: true },
    'command-a-vision-07-2025': { capability: 0.88, contextWindow: 128000, isVision: true },
    'c4ai-aya-expanse-32b': { capability: 0.80, contextWindow: 128000 },
    'command-r7b-12-2024': { capability: 0.80, contextWindow: 128000 },
    'gemma4:31b': { capability: 0.90, contextWindow: 300000 },

    // Coder Models
    'qwen/qwen3-coder-480b-a35b-instruct': { capability: 0.96, contextWindow: 128000, isCoder: true },
    'qwen/qwen3-coder-480b-a35b:free': { capability: 0.96, contextWindow: 128000, isCoder: true },
    'Qwen/Qwen2.5-Coder-7B-Instruct': { capability: 0.78, contextWindow: 32000, isCoder: true },
    'Qwen/Qwen3-Coder-30B-A3B-Instruct': { capability: 0.88, contextWindow: 128000, isCoder: true },
    'openai/gpt-oss-20b': { capability: 0.75, contextWindow: 32000 },
    'openai/gpt-oss-20b:free': { capability: 0.75, contextWindow: 32000 },
    'gpt-oss:20b': { capability: 0.78, contextWindow: 32000 },
    'codestral-latest': { capability: 0.88, contextWindow: 128000, isCoder: true },
    'poolside/laguna-s-2.1:free': { capability: 0.85, contextWindow: 128000, isCoder: true, isReasoning: true },
    'poolside/laguna-s-2.1': { capability: 0.85, contextWindow: 128000, isCoder: true, isReasoning: true },
    'qwen/qwen3.8-flash': { capability: 0.90, contextWindow: 1000000, isCoder: true, isReasoning: true, isVision: true },
    'qwen/qwen3.7-flash': { capability: 0.82, contextWindow: 1000000, isReasoning: true, isVision: true },
    'meta/llama-4-scout': { capability: 0.85, contextWindow: 131072, isVision: true },
    'mistralai/mistral-small-3.2': { capability: 0.82, contextWindow: 128000 },
    'inclusionai/ling-3.0-flash-vl': { capability: 0.84, contextWindow: 131072, isVision: true },
    'google/gemini-2.5-flash-lite:search': { capability: 0.85, contextWindow: 1048576 },
    'openai/gpt-5.4-nano': { capability: 0.80, contextWindow: 400000 },
    'kilo-auto/free': { capability: 0.85, contextWindow: 128000, isCoder: true },
    'liquid/lfm-2.5-2.6b:free': { capability: 0.80, contextWindow: 32000 },

    // A-Tier & Multimodal Models
    'Qwen/Qwen3.8-Flash-Next': { capability: 0.92, contextWindow: 131072, isVision: true, isReasoning: true },
    'qwen/qwen3.8-27b': { capability: 0.90, contextWindow: 131072, isVision: true, isReasoning: true },
    'qwen/qwen3.8-27b:free': { capability: 0.90, contextWindow: 131072, isVision: true, isReasoning: true, isCoder: true },
    'inclusionai/ling-3.0-flash-fin:free': { capability: 0.90, contextWindow: 262144, isCoder: true, isReasoning: true },
    'mistralai/mistral-nemotron': { capability: 0.88, contextWindow: 128000 },
    'open-mistral-nemo': { capability: 0.88, contextWindow: 400000 },
    'google/gemma-3-27b-it': { capability: 0.88, contextWindow: 130000, isVision: true },
    'meta-llama/Llama-3.3-70B-Instruct': { capability: 0.85, contextWindow: 128000 },
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { capability: 0.85, contextWindow: 128000 },
    '@cf/meta/llama-4-scout-17b-16e-instruct': { capability: 0.90, contextWindow: 128000, isVision: true },
    '@cf/google/gemma-4-26b-a4b-it': { capability: 0.94, contextWindow: 128000, isVision: true },
    '@cf/google/gemma-3-12b-it': { capability: 0.82, contextWindow: 128000, isVision: true },
    '@cf/mistralai/mistral-small-3.1-24b-instruct': { capability: 0.84, contextWindow: 128000, isVision: true },
    '@cf/qwen/qwen2.5-coder-32b-instruct': { capability: 0.88, contextWindow: 128000, isCoder: true },
    '@cf/qwen/qwq-32b': { capability: 0.88, contextWindow: 128000, isReasoning: true },
    '@cf/openai/gpt-oss-120b': { capability: 0.94, contextWindow: 128000 },
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { capability: 0.92, contextWindow: 128000, isReasoning: true },
    '@cf/qwen/qwen3.8-27b': { capability: 0.90, contextWindow: 131072, isVision: true, isReasoning: true, isCoder: true },
    '@cf/qwen/qwen3-30b-a3b-fp8': { capability: 0.88, contextWindow: 128000, isCoder: true },
    '@cf/nvidia/nemotron-3-120b-a12b': { capability: 0.90, contextWindow: 128000, isReasoning: true },
    '@cf/openai/gpt-oss-20b': { capability: 0.78, contextWindow: 32000 },
    '@cf/meta/llama-3.1-8b-instruct-fp8': { capability: 0.75, contextWindow: 128000 },
    '@cf/meta/llama-3.2-3b-instruct': { capability: 0.70, contextWindow: 128000 },
    '@cf/meta/llama-3.2-1b-instruct': { capability: 0.65, contextWindow: 128000 },
    '@cf/ibm-granite/granite-4.0-h-micro': { capability: 0.65, contextWindow: 128000 },
    '@cf/meta/llama-guard-3-8b': { capability: 0.75, contextWindow: 32000 },
    '@cf/aisingapore/gemma-sea-lion-v4-27b-it': { capability: 0.82, contextWindow: 128000 },
    '@cf/black-forest-labs/flux-1-schnell': { capability: 0.90, contextWindow: 32000, isImageGeneration: true },
    '@cf/bytedance/stable-diffusion-xl-lightning': { capability: 0.88, contextWindow: 32000, isImageGeneration: true },
    '@cf/lykon/dreamshaper-8-lcm': { capability: 0.85, contextWindow: 32000, isImageGeneration: true },
    'mistral-large-latest': { capability: 0.85, contextWindow: 128000 },
    'mistral-medium-latest': { capability: 0.84, contextWindow: 20000 },
    'mistral-medium-3-5': { capability: 0.87, contextWindow: 128000 },
    'mistral-small-latest': { capability: 0.82, contextWindow: 128000 },
    'ministral-8b-latest': { capability: 0.82, contextWindow: 128000 },
    'ministral-8b-2512': { capability: 0.83, contextWindow: 128000 },
    'ministral-3b-2512': { capability: 0.78, contextWindow: 128000 },
    'ministral-14b-2512': { capability: 0.86, contextWindow: 128000 },
    'mistralai/mistral-small-3.1-24b:free': { capability: 0.82, contextWindow: 128000 },
    'Qwen/Qwen2.5-72B-Instruct': { capability: 0.85, contextWindow: 128000 },
    'Qwen/Qwen2.5-7B-Instruct': { capability: 0.80, contextWindow: 32000 },
    'Qwen/Qwen3-8B': { capability: 0.70, contextWindow: 32000 },
    'gemini-3.5-flash-lite': { capability: 0.85, contextWindow: 100000, isVision: true },
    'gemini-3.1-flash-lite': { capability: 0.82, contextWindow: 150000, isVision: true },
    'meta-llama/llama-4-maverick:free': { capability: 0.88, contextWindow: 128000, isVision: true },
    'meta-llama/llama-4-scout:free': { capability: 0.88, contextWindow: 128000, isVision: true },
    'meta-llama/Llama-3.1-8B-Instruct': { capability: 0.75, contextWindow: 128000 },
    'meta/llama-3.1-8b-instruct': { capability: 0.75, contextWindow: 128000 },
    'google/gemma-3-4b-it': { capability: 0.72, contextWindow: 130000, isVision: true },
    'arcee-ai/trinity-large-preview:free': { capability: 0.85, contextWindow: 128000 },
    'arcee-ai/trinity-mini:free': { capability: 0.75, contextWindow: 128000 },
    'openrouter/free': { capability: 0.80, contextWindow: 128000 },
    'z-ai/glm-4.5-air:free': { capability: 0.75, contextWindow: 128000 },
    'stepfun/step-3.7-flash:free': { capability: 0.84, contextWindow: 128000, isVision: true },
    'glm-4.5-flash': { capability: 0.80, contextWindow: 128000 },
    'glm-4.7-flash': { capability: 0.85, contextWindow: 128000 },
    'glm-4.6V-flash': { capability: 0.82, contextWindow: 128000, isVision: true },

    // ModelScope / Zhipu flagship
    'zai-org/GLM-5.2': { capability: 0.98, contextWindow: 128000 },
    'zai-org/GLM-5.1': { capability: 0.96, contextWindow: 128000 },
    'zai-org/GLM-5': { capability: 0.94, contextWindow: 128000 },
    'zai-org/GLM-4.7-Flash': { capability: 0.85, contextWindow: 128000 },
    'deepseek-ai/DeepSeek-V4-Pro': { capability: 0.98, contextWindow: 128000, isReasoning: true },
    'deepseek-ai/DeepSeek-V4.1-Flash': { capability: 0.90, contextWindow: 128000, isCoder: true, isReasoning: true },
    'deepseek-ai/deepseek-v4.1-flash': { capability: 0.90, contextWindow: 128000, isCoder: true, isReasoning: true },
    'deepseek-ai/DeepSeek-V4-Flash': { capability: 0.88, contextWindow: 128000 },
    'deepseek-ai/DeepSeek-V3.2': { capability: 0.94, contextWindow: 128000 },
    'Qwen/Qwen3.5-397B-A17B': { capability: 0.96, contextWindow: 128000, isVision: true },
    'Qwen/Qwen-Image-2.1': { capability: 0.94, contextWindow: 32000, isImageGeneration: true },
    'BBB662/ndf-krea2': { capability: 0.92, contextWindow: 32000, isImageGeneration: true },
    'MArilei/PiB': { capability: 0.91, contextWindow: 32000, isImageGeneration: true },
    'Qwen/Qwen3-VL-235B-A22B-Instruct': { capability: 0.92, contextWindow: 128000, isVision: true },
    'stepfun-ai/Step-3.5-Flash': { capability: 0.82, contextWindow: 128000, isVision: true },

    // Ollama Cloud active models
    'nemotron-3-ultra': { capability: 0.90, contextWindow: 128000 },
    'nemotron-3-super': { capability: 0.88, contextWindow: 128000 },
    'nemotron-3-nano:30b': { capability: 0.80, contextWindow: 32000 },
    'minimax-m3': { capability: 0.90, contextWindow: 128000 },

    // NVIDIA NIM active & free models
    'nvidia/nemotron-3.5-lightning-30b-a3b': { capability: 0.92, contextWindow: 128000, isCoder: true, isReasoning: true },
    'nvidia/nemotron-3.5-lightning:free': { capability: 0.92, contextWindow: 128000, isCoder: true, isReasoning: true },
    'meta/muse-glimmer-30b': { capability: 0.92, contextWindow: 128000, isVision: true, isReasoning: true },
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': { capability: 0.90, contextWindow: 128000, isVision: true, isReasoning: true },
    'nvidia/nemotron-3-nano-30b-a3b': { capability: 0.82, contextWindow: 128000 },
    'nvidia/nemotron-3-super-120b-a12b:free': { capability: 0.88, contextWindow: 128000, isReasoning: true },
    'nvidia/nemotron-3-ultra-550b-a55b': { capability: 0.88, contextWindow: 300000, isReasoning: true },
    'nvidia/nemotron-3-ultra-550b-a55b:free': { capability: 0.88, contextWindow: 300000, isReasoning: true },
    'nvidia/llama-3.3-nemotron-super-49b-v1': { capability: 0.90, contextWindow: 128000 },
    'nvidia/llama-3.1-nemotron-nano-vl-8b-v1': { capability: 0.82, contextWindow: 128000, isVision: true },
    'nvidia/nemotron-nano-12b-v2-vl': { capability: 0.85, contextWindow: 128000, isVision: true },
    'nvidia/nemotron-mini-4b-instruct': { capability: 0.65, contextWindow: 32000 },
    'nvidia/nemotron-mini-4b-instruct:free': { capability: 0.65, contextWindow: 32000 },
    'meta/llama-3.2-11b-vision-instruct': { capability: 0.80, contextWindow: 128000, isVision: true },
    'meta/llama-3.2-90b-vision-instruct': { capability: 0.86, contextWindow: 128000, isVision: true },
    'minimaxai/minimax-m3': { capability: 0.90, contextWindow: 128000, isVision: true },
    'google/diffusiongemma-26b-a4b-it': { capability: 0.88, contextWindow: 128000, isReasoning: true },
    'moonshotai/kimi-k3': { capability: 0.92, contextWindow: 128000, isReasoning: true },
    'tencent/hy3:free': { capability: 0.88, contextWindow: 128000, isReasoning: true },
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': { capability: 0.90, contextWindow: 256000, isVision: true, isReasoning: true },
    'minimax-m2.7': { capability: 0.85, contextWindow: 128000 },
    'nvidia/nemotron-3-super-120b-a12b': { capability: 0.93, contextWindow: 1000000, isReasoning: true },
    'nvidia/ising-calibration-1-35b-a3b': { capability: 0.86, contextWindow: 64000, isVision: true },
    'nvidia/ising-calibration-1.5-31b': { capability: 0.90, contextWindow: 128000, isVision: true, isReasoning: true },
    'nvidia/nemotron-3.5-content-safety': { capability: 0.75, contextWindow: 32000 },
    '@cf/zai-org/glm-4.7-flash': { capability: 0.86, contextWindow: 128000 },
    'mistral-Nemo-Instruct-2407': { capability: 0.85, contextWindow: 128000 },

    'deepseek-ai/deepseek-coder-6.7b-instruct': { capability: 0.82, contextWindow: 32000, isCoder: true },
    'z-ai/glm-5.3-flash': { capability: 0.88, contextWindow: 128000, isReasoning: true },
    'z-ai/glm-5.3': { capability: 0.94, contextWindow: 128000, isReasoning: true, isCoder: true },
    'Qwen/Qwen3.5-35B-A3B': { capability: 0.90, contextWindow: 128000, isReasoning: true, isCoder: true },
    'Qwen/Qwen3.5-27B': { capability: 0.88, contextWindow: 128000, isCoder: true },

    // Pollinations community and verified models
    'community/AkshayCoder48/stepfun-step-3.7-flash-free': { capability: 0.84, contextWindow: 128000 },
    'community/AkshayCoder48/grok-4-fast': { capability: 0.88, contextWindow: 128000, isReasoning: true },
    'community/AkshayCoder48/cohere-north-mini-code:free': { capability: 0.84, contextWindow: 128000, isCoder: true },
    'community/AkshayCoder48/kilo-auto-free': { capability: 0.85, contextWindow: 128000, isCoder: true, isReasoning: true },
    'community/AkshayCoder48/gemini-3.1-flash-lite': { capability: 0.85, contextWindow: 150000, isVision: true, isReasoning: true },
    'community/AkshayCoder48/gemini-2.5-flash': { capability: 0.86, contextWindow: 150000, isVision: true, isReasoning: true },
    'community/AkshayCoder48/nvidia-nemotron-3-super-120b-a12b-free': { capability: 0.90, contextWindow: 128000, isReasoning: true },

    // AionLabs Storytelling & Roleplaying (accessible strictly via movie_tool)
    'aion-labs/aion-3.5': { capability: 0.95, contextWindow: 262144, isRoleplaying: true },
    'aion-labs/aion-3.5-mini': { capability: 0.90, contextWindow: 262144, isRoleplaying: true },
    'aion-labs/aion-3.0': { capability: 0.92, contextWindow: 131072, isRoleplaying: true },
    'aion-labs/aion-3.0-mini': { capability: 0.88, contextWindow: 131072, isRoleplaying: true },
    'aion-labs/aion-2.0': { capability: 0.88, contextWindow: 131072, isRoleplaying: true },
    'aion-labs/aion-rp-llama-3.1-8b': { capability: 0.78, contextWindow: 32768, isRoleplaying: true },

    // Pollinations / Multimodal Media Models (Keyframes, Audio, Video)
    'black-forest-labs/flux.1-schnell': { capability: 0.90, contextWindow: 32000, isImageGeneration: true },
    'tongyi-mai/z-image-turbo': { capability: 0.88, contextWindow: 32000, isImageGeneration: true },
    'lykon/dreamshaper-8-lcm': { capability: 0.85, contextWindow: 32000, isImageGeneration: true },
    'community/MarcosFRG/flux-1-schnell': { capability: 0.88, contextWindow: 32000, isImageGeneration: true },
    'hexgrad/kokoro-82m': { capability: 0.90, contextWindow: 32000, isAudio: true },
    'qwen/qwen3-tts-flash': { capability: 0.88, contextWindow: 32000, isAudio: true },
    'alibaba/wan-2.2-fast': { capability: 0.88, contextWindow: 32000, isVideo: true },
};

/**
 * Check if a model is an image generation / T2I model
 */
export function isImageGenModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isImageGeneration;
}

/**
 * Check if a model is an audio / speech synthesis model
 */
export function isAudioModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isAudio;
}

/**
 * Check if a model is a video / motion generation model
 */
export function isVideoModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isVideo;
}

/**
 * Check if a model is strictly a roleplaying/storytelling model
 */
export function isRoleplayingModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isRoleplaying;
}

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
export function isVisionSupported(modelId: string, capabilities?: string[]): boolean {
    if (Array.isArray(capabilities) && capabilities.includes('vision')) {
        return true;
    }
    const meta = MODEL_METADATA[modelId];
    if (meta?.isVision !== undefined) {
        return meta.isVision;
    }
    if (meta?.isVisionOnly) {
        return true;
    }
    return false;
}

/**
 * Check if a model is strictly vision/multimodal only and cannot handle general text tasks
 */
export function isVisionOnlyModel(modelId: string): boolean {
    return !!MODEL_METADATA[modelId]?.isVisionOnly;
}

