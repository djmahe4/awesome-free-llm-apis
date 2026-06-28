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

import { getModelContextLimit as getCentralizedLimit } from '../config/models.js';

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

  return getCentralizedLimit(modelId);
}

export const MODEL_TOKEN_DEFAULT = DEFAULT_MAX_TOKENS;
