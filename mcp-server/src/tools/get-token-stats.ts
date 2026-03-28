import { sharedTokenManager } from './use-free-llm.js';

export async function getTokenStats() {
    const stats = sharedTokenManager.getTrackingState();
    return {
        success: true,
        stats,
    };
}
