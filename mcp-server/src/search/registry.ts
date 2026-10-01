import type { SearchProvider } from './types.js';
import { ParallelSearchProvider } from './providers/parallel.js';
import { TinyFishSearchProvider } from './providers/tinyfish.js';
import { TavilySearchProvider } from './providers/tavily.js';
import { DdgsMcpSearchProvider } from './providers/ddgs.js';
import { JinaSearchProvider } from './providers/jina.js';
import { SearxngSearchProvider } from './providers/searxng.js';

import { persistence } from '../utils/PersistenceManager.js';

/**
 * Fallback order: Parallel AI -> TinyFish -> Tavily -> DDGS (MCP) -> Jina -> SearXNG.
 * Parallel is keyless/highest-throughput so it goes first; SearXNG is the
 * self-hosted terminal fallback.
 */
export class SearchProviderRegistry {
  private static instance: SearchProviderRegistry;
  private providers: SearchProvider[];
  private initialized = false;

  private constructor() {
    this.providers = [
      new ParallelSearchProvider(),
      new TinyFishSearchProvider(),
      new TavilySearchProvider(),
      new DdgsMcpSearchProvider(),
      new JinaSearchProvider(),
      new SearxngSearchProvider(),
    ];
  }

  static getInstance(): SearchProviderRegistry {
    if (!SearchProviderRegistry.instance) {
      SearchProviderRegistry.instance = new SearchProviderRegistry();
      SearchProviderRegistry.instance.initFromPersistence().catch(() => {});
    }
    return SearchProviderRegistry.instance;
  }

  async initFromPersistence(): Promise<void> {
    if (this.initialized) return;
    try {
      const data = await persistence.load();
      if (data.searchProviders) {
        for (const p of this.providers) {
          const spData = data.searchProviders[p.id];
          if (spData) {
            if (typeof spData.consecutiveFailures === 'number') {
              p.consecutiveFailures = spData.consecutiveFailures;
            }
            if (typeof spData.cooldownUntil === 'number') {
              p.cooldownUntil = spData.cooldownUntil;
            }
            if (typeof spData.lastFailure === 'number') {
              p.lastFailure = spData.lastFailure;
            }
          }
        }
      }
      this.initialized = true;
    } catch {
      // Best-effort load
    }
  }

  async persistState(): Promise<void> {
    try {
      const searchProviders: Record<string, { consecutiveFailures?: number; cooldownUntil?: number; lastFailure?: number }> = {};
      for (const p of this.providers) {
        searchProviders[p.id] = {
          consecutiveFailures: p.consecutiveFailures,
          cooldownUntil: p.cooldownUntil,
          lastFailure: p.lastFailure || undefined,
        };
      }
      await persistence.saveSearchProviders(searchProviders);
    } catch {
      // Best-effort persist
    }
  }

  static resetInstance(): void {
    (SearchProviderRegistry as any).instance = undefined;
  }

  getProviders(): SearchProvider[] {
    return this.providers;
  }

  getAvailableProviders(): SearchProvider[] {
    return this.providers.filter(p => p.isAvailable());
  }
}
