import { sharedRouter } from './use-free-llm.js';
import { ProviderRegistry } from '../providers/registry.js';

export async function getTokenStats() {
    const tracking = sharedRouter.getTokenState();
    const registry = ProviderRegistry.getInstance();
    const allProviders = registry.getAllProviders();

    const stats = allProviders.map(p => ({
        id: p.id,
        name: p.name,
        isAvailable: p.isAvailable(),
        rateLimits: p.rateLimits,
        usage: tracking[p.id] || { remainingTokens: undefined, refreshTime: undefined }
    }));

    return {
        success: true,
        stats,
    };
}
