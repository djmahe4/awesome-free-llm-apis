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
            tokens: tracking[p.id]?.remainingTokens ?? '?',
            localTotalRequests: tracking[p.id]?.localTotalRequests ?? 0,
            localTotalTokens: tracking[p.id]?.localTotalTokens ?? 0,
            dailyTotalRequests: tracking[p.id]?.dailyTotalRequests ?? 0,
            dailyTotalTokens: tracking[p.id]?.dailyTotalTokens ?? 0
        }
    }));

    // Calculate global server totals
    const serverTotals = {
        dailyRequests: stats.reduce((acc, s) => acc + (s.usage.dailyTotalRequests || 0), 0),
        dailyTokens: stats.reduce((acc, s) => acc + (s.usage.dailyTotalTokens || 0), 0),
        lifetimeRequests: stats.reduce((acc, s) => acc + (s.usage.localTotalRequests || 0), 0),
        lifetimeTokens: stats.reduce((acc, s) => acc + (s.usage.localTotalTokens || 0), 0)
    };

    return {
        success: true,
        stats,
        serverTotals
    };
}
