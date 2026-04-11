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
        usage: {
            requests: tracking[p.id]?.remainingRequests ?? '?',
            tokens: tracking[p.id]?.remainingTokens ?? '?'
        }

    }));

    return {
        success: true,
        stats,
    };
}
