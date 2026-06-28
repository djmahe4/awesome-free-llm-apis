import { ProviderRegistry } from '../providers/registry.js';

const DEFAULT_MAX_TOKENS = 1024;

function inferModelSizeBillions(modelId?: string): number | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  const matches = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:b|bn|billion)\b/g)];
  if (matches.length === 0) return undefined;
  return Number(matches[matches.length - 1][1]);
}

export function calculateModelWeightedMaxTokens(modelId?: string): number {
  if (!modelId) return DEFAULT_MAX_TOKENS;
  const lower = modelId.toLowerCase();

  // If it's a reasoning model, give it a large output token budget
  if (lower.includes('r1') || lower.includes('reasoning') || lower.includes('thinking') || lower.includes('o1') || lower.includes('o3')) {
    return 16384;
  }

  const size = inferModelSizeBillions(modelId);
  if (!size || !Number.isFinite(size)) return DEFAULT_MAX_TOKENS;

  if (size <= 7) return 512;
  if (size <= 13) return 768;
  if (size <= 34) return 1024;
  if (size <= 70) return 2048;
  if (size <= 120) return 3072;
  return 4096;
}

export function getModelContextLimit(modelId?: string): number {
  if (!modelId) return 32000;

  try {
    const registry = ProviderRegistry.getInstance();
    const provider = registry.getProviderForModel(modelId);
    if (provider) {
      const model = provider.models.find(m => m.id === modelId) || 
                    provider.visionModels?.find(m => m.id === modelId);
      if (model?.contextWindow) {
        return model.contextWindow;
      }
    }
  } catch (err) {
    // Registry not fully initialized or other error
  }

  const lower = modelId.toLowerCase();
  
  if (lower.includes('gemini')) return 150000;
  if (lower.includes('gemma')) return 130000;
  if (lower.includes('claude')) return 200000;
  if (lower.includes('gpt-4o') || lower.includes('gpt-4') || lower.includes('gpt-5')) return 128000;
  if (lower.includes('llama-4') || lower.includes('llama-3') || lower.includes('llama3')) return 128000;
  if (lower.includes('llama-2') || lower.includes('llama2')) return 8000;
  if (lower.includes('deepseek-r1') || lower.includes('r1')) return 64000;
  if (lower.includes('deepseek-v3')) return 128000;
  if (lower.includes('qwen3') || lower.includes('qwen2.5')) return 128000;
  if (lower.includes('phi-4')) return 128000;
  if (lower.includes('nemotron-3')) return 128000;
  if (lower.includes('ministral-3') || lower.includes('mistral-large')) return 128000;

  const size = inferModelSizeBillions(modelId);
  if (size) {
    if (size <= 8) return 8000;
    if (size <= 70) return 32000;
  }
  return 32000;
}

export const MODEL_TOKEN_DEFAULT = DEFAULT_MAX_TOKENS;
