import { ProviderRegistry } from '../providers/registry.js';
import type { ChatRequest, ChatResponse, Provider } from '../providers/types.js';

export class Router {
  private failedProviders: Set<string> = new Set();

  private get registry(): ProviderRegistry {
    return ProviderRegistry.getInstance();
  }

  route(model: string, providerId?: string): Provider {
    if (providerId) {
      const provider = this.registry.getProvider(providerId);
      if (!provider) throw new Error(`Provider '${providerId}' not found`);
      return provider;
    }
    const provider = this.registry.getProviderForModel(model);
    if (!provider) throw new Error(`No provider found for model '${model}'`);
    return provider;
  }

  getProviderPriority(model: string): Provider[] {
    const providers: Provider[] = [];
    for (const provider of this.registry.getAllProviders()) {
      if (provider.models.some((m) => m.id === model)) {
        providers.push(provider);
      }
    }
    return providers.sort((a, b) => {
      const aAvail = a.isAvailable() && !this.failedProviders.has(a.id) ? 0 : 1;
      const bAvail = b.isAvailable() && !this.failedProviders.has(b.id) ? 0 : 1;
      return aAvail - bAvail;
    });
  }

  async routeWithFallback(
    model: string,
    request: ChatRequest,
    fallbackModels?: string[]
  ): Promise<ChatResponse> {
    const providers = this.getProviderPriority(model);
    const modelsToTry = [model, ...(fallbackModels ?? [])];

    for (const tryModel of modelsToTry) {
      const tryProviders = tryModel === model
        ? providers
        : this.getProviderPriority(tryModel);

      for (const provider of tryProviders) {
        if (!provider.isAvailable()) continue;
        try {
          const response = await provider.chat({ ...request, model: tryModel });
          return response;
        } catch {
          this.failedProviders.add(provider.id);
        }
      }
    }
    throw new Error(`All providers failed for model '${model}'`);
  }

  resetFailedProviders(): void {
    this.failedProviders.clear();
  }
}
