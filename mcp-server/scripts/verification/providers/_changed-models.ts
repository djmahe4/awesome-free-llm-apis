/**
 * @file _changed-models.ts
 * @description Model IDs added/removed per provider by upstream data.json merges
 * (including 2026-08-21 167013f, 2026-10-05 41197cb and 2026-10-23 upstream/main). Used by the provider
 * smoke-test scripts to verify newly added models and confirm whether removed
 * models are truly dead.
 * Gemini is excluded per user instruction.
 * Cerebras and GitHub Models are fully deprecated.
 */

export interface ChangedModels {
  added: string[];
  removed: string[];
}

export const CHANGED_MODELS: Record<string, ChangedModels> = {
  // cerebras entry removed as of v1.1.0 — provider fully deprecated (free tier replaced by mandatory payment method)
  // github-models entry removed as of v1.0.9 — provider fully deprecated (see src/providers/github-models.ts)
  cohere: {
    added: [],
    removed: [],
  },
  groq: {
    added: [
      'qwen/qwen3.8-27b',
    ],
    removed: [
      'groq/compound',
      'groq/compound-mini',
      'qwen/qwen3.6-27b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  },
  huggingface: {
    added: [],
    removed: [],
  },
  kilocode: {
    added: [
      'tencent/hy3:free',
      'nvidia/nemotron-3.5-lightning:free',
      'liquid/lfm-2.5-2.6b:free',
      'cohere/north-mini-code:free',
      'poolside/laguna-s-2.1:free',
      'poolside/laguna-xs-2.1:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'kilo-auto/free',
      'inclusionai/ling-3.1-flash',
      'apodex/apodex-1.1-mini:free',
      'dots-studio/dots-3-note-preview:free',
      'recursive/flint-v1.0:free',
      'xingchen-agi/xing4.0-29b-a4b:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'reflection/beam-free',
    ],
    removed: [
      'inclusionai/ling-3.0-flash:free',
      'inclusionai/ling-3.0-flash-sante:free',
      'stepfun/step-3.7-flash:free',
      'qwen/qwen3.8-27b:free',
    ],
  },
  mistral: {
    added: [
      'mistral-medium-3-5',
      'ministral-8b-2512',
      'ministral-3b-2512',
      'ministral-14b-2512',
    ],
    removed: [
      'mistral-medium-2604',
    ],
  },
  nvidia: {
    added: [],
    removed: [
      'nvidia/nemotron-3-nano-30b-a3b',
      'meta/llama-3.3-70b-instruct',
      'mistralai/mistral-nemotron',
      'minimaxai/minimax-m3',
      'openai/gpt-oss-120b',
      'deepseek-ai/deepseek-v4-flash',
      'mistralai/mistral-medium-3.5-128b',
      'deepseek-ai/deepseek-v4-pro',
    ],
  },
  'ollama-cloud': {
    added: [],
    removed: [],
  },
  openrouter: {
    added: [
      'apodex/apodex-1.1-mini:free',
      'inclusionai/ling-3.0-flash-sante:free',
      'qwen/qwen3.8-27b:free',
      'dots-studio/dots-3-note-preview:free',
      'liquid/lfm-2.5-2.6b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'thinkingmachines/inkling:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'recursive/flint-v1.0:free',
      'xingchen-agi/xing4.0-29b-a4b:free',
      'nvidia/nemotron-3.5-super-vl:free',
    ],
    removed: [
      'openai/gpt-oss-20b:free',
      'inclusionai/ling-3.0-flash:free',
      'nvidia/nemotron-3-nano-30b-a3b:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'nvidia/nemotron-nano-9b-v2:free',
    ],
  },
  llm7: {
    added: [
      'gpt-oss:20b',
      'mistral-Nemo-Instruct-2407',
      'minimax-m2.7',
      'nemotron-3-nano:30b',
      'codestral-latest',
    ],
    removed: [
      'DeepSeek-V4-Flash-0731',
      'deepseek-r1-0528',
      'deepseek-v3-0324',
      'gemini-2.5-flash-lite',
      'gpt-4o-mini',
      'mistral-small-3.1-24b',
      'qwen2.5-coder-32b',
    ],
  },
  siliconflow: {
    added: [
      'tencent/Hunyuan-MT-7B',
      'XingChenAGI/Xing4.0-29B',
    ],
    removed: [
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
      'Qwen/Qwen3-8B',
    ],
  },
  modelscope: {
    added: [
      'Qwen/Qwen3.5-35B-A3B',
      'Qwen/Qwen3.5-27B',
    ],
    removed: [],
  },
  cloudflare: {
    added: [
      '@cf/google/gemma-4-26b-a4b-it',
      '@cf/zai-org/glm-4.7-flash',
    ],
    removed: [
      '@cf/moonshotai/kimi-k2.7-code',
      '@cf/zhipuai/glm-4.7-flash',
    ],
  },
  // gonka-broker: new upstream provider (2026-10-23) - MiniMaxAI/MiniMax-M2.7, deepseek-ai/DeepSeek-V4-Flash-0731,
  // zai-org/GLM-5.3-Flash, BAAI/bge-m3 (embeddings); no local provider adapter yet.
  zhipu: {
    added: [],
    removed: [],
  },
};
