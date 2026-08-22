import { getSharedRouter } from '../pipeline/instances.js';
import { ProviderRegistry } from '../providers/registry.js';
import { persistence } from '../utils/PersistenceManager.js';

export async function getTokenStats() {
    const tracking = getSharedRouter().getTokenState();
    const registry = ProviderRegistry.getInstance();
    const allProviders = registry.getAllProviders();

    let diskState: any = null;
    try {
        diskState = await persistence.load();
    } catch {
        diskState = null;
    }

    const stats = allProviders.map(p => {
        const live = tracking[p.id] || {};
        const diskProv = diskState?.providers?.[p.id] || {};

        // Merge live memory accumulation with persisted local stats
        const localTotalRequests = Math.max(live.localTotalRequests || 0, diskProv.localTotalRequests || 0);
        const localTotalTokens = Math.max(live.localTotalTokens || 0, diskProv.localTotalTokens || 0);
        const dailyTotalRequests = live.dailyTotalRequests !== undefined ? live.dailyTotalRequests : (diskState?.dailyTotalRequests || 0);
        const dailyTotalTokens = live.dailyTotalTokens !== undefined ? live.dailyTotalTokens : (diskState?.dailyTotalTokens || 0);

        return {
            id: p.id,
            name: p.name,
            isAvailable: p.isAvailable(),
            rateLimits: p.rateLimits,
            usage: {
                requests: live.remainingRequests ?? diskProv.remainingRequests ?? '?',
                tokens: live.remainingTokens ?? diskProv.remainingTokens ?? '?',
                localTotalRequests,
                localTotalTokens,
                dailyTotalRequests,
                dailyTotalTokens
            }
        };
    });

    // Calculate global server totals
    const serverTotals = {
        dailyRequests: diskState?.dailyTotalRequests ?? stats.reduce((acc, s) => acc + (s.usage.dailyTotalRequests || 0), 0),
        dailyTokens: diskState?.dailyTotalTokens ?? stats.reduce((acc, s) => acc + (s.usage.dailyTotalTokens || 0), 0),
        lifetimeRequests: diskState?.lifetimeTotalRequests ?? stats.reduce((acc, s) => acc + (s.usage.localTotalRequests || 0), 0),
        lifetimeTokens: diskState?.lifetimeTotalTokens ?? stats.reduce((acc, s) => acc + (s.usage.localTotalTokens || 0), 0)
    };

    return {
        success: true,
        stats,
        serverTotals
    };
}
