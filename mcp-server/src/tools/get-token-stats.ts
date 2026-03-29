import { sharedTokenManager } from './use-free-llm.js';
import { ProviderRegistry } from '../providers/registry.js';

export async function getTokenStats() {
    const tracking = sharedTokenManager.getTrackingState();
    const registry = ProviderRegistry.getInstance();
    const allProviders = registry.getAllProviders();

    const stats = allProviders.map(p => ({
        id: p.id,
        name: p.name,
        isAvailable: p.isAvailable(),
        rateLimits: p.rateLimits,
        usage: tracking[p.id] || { tokens: 0, requests: 0 }
    }));

    return {
        success: true,
        stats,
    };
}
