import { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';

export interface ListModelsInput {
  provider?: string;
  available_only?: boolean;
}

export interface ModelInfo {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  rateLimits: Record<string, number | undefined>;
  available: boolean;
}

export async function listAvailableFreeModels(input: ListModelsInput): Promise<{
  models: ModelInfo[];
  summary: string;
}> {
  const registry = ProviderRegistry.getInstance();
  let providers: Provider[];

  if (input.provider) {
    const p = registry.getProvider(input.provider);
    providers = p ? [p] : [];
  } else {
    providers = registry.getAllProviders();
  }

  if (input.available_only) {
    providers = providers.filter((p) => p.isAvailable());
  }

  const models: ModelInfo[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      models.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
        rateLimits: provider.rateLimits as Record<string, number | undefined>,
        available: provider.isAvailable(),
      });
    }
  }

  const availableCount = models.filter((m) => m.available).length;
  const summary = `Found ${models.length} models across ${providers.length} providers (${availableCount} available).`;

  return { models, summary };
}
