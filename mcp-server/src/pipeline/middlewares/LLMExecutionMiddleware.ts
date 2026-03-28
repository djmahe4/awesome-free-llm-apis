import { ProviderRegistry } from '../../providers/registry.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';

export class LLMExecutionMiddleware implements Middleware {
    name = 'LLMExecutionMiddleware';

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        if (!context.providerId) {
            throw new Error(`[LLMExecution] No providerId specified in context`);
        }

        const registry = ProviderRegistry.getInstance();
        const provider = registry.getProvider(context.providerId);

        if (!provider) {
            throw new Error(`[LLMExecution] Provider ${context.providerId} not found`);
        }

        // Call the actual provider
        context.response = await provider.chat(context.request);

        // Continue the bubbling back up the stack
        await next();
    }
}
