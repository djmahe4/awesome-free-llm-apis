const DEFAULT_MAX_TOKENS = 1024;

function inferModelSizeBillions(modelId?: string): number | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  const matches = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:b|bn|billion)\b/g)];
  if (matches.length === 0) return undefined;
  return Number(matches[matches.length - 1][1]);
}

export function calculateModelWeightedMaxTokens(modelId?: string): number {
  const size = inferModelSizeBillions(modelId);
  if (!size || !Number.isFinite(size)) return DEFAULT_MAX_TOKENS;

  if (size <= 7) return 512;
  if (size <= 13) return 768;
  if (size <= 34) return 1024;
  if (size <= 70) return 2048;
  if (size <= 120) return 3072;
  return 4096;
}

export const MODEL_TOKEN_DEFAULT = DEFAULT_MAX_TOKENS;
