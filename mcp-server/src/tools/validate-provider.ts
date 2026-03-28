import { ProviderRegistry } from '../providers/registry.js';

export async function validateProvider(providerId: string) {
    const registry = ProviderRegistry.getInstance();
    const provider = registry.getProvider(providerId);

    if (!provider) {
        throw new Error(`Provider not found: ${providerId}`);
    }

    const available = provider.isAvailable();
    if (!available) {
        return {
            success: false,
            message: `Provider ${provider.name} is missing a valid API key or has a placeholder value.`,
            isPlaceholder: true
        };
    }

    try {
        const model = provider.models[0];
        if (!model) {
            return { success: false, message: 'No models defined for this provider.' };
        }

        // Execution a minimal health check
        const response = await provider.chat({
            model: model.id,
            messages: [{ role: 'user', content: 'health-check' }],
            max_tokens: 1
        });

        return {
            success: true,
            message: 'Provider is online and successfully authenticated.',
            latencyMs: response._headers?.['x-response-time'] || 'N/A'
        };
    } catch (err: any) {
        return {
            success: false,
            message: `Live health check failed: ${err.message}`,
            error: err.stack
        };
    }
}
