import { join } from 'node:path';
import { ResponseCache } from '../../cache/index.js';
import { memoryManager } from '../../memory/index.js';
import { config } from '../../config/index.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';

export class ResponseCacheMiddleware implements Middleware {
    name = 'ResponseCacheMiddleware';

    private cache: ResponseCache;

    constructor() {
        this.cache = new ResponseCache(500, config.cacheStorePath);
    }

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        const wsHash = context.wsHash || 'global';

        // Generate cache key
        const cacheKey = this.cache.generateKey(context.request, wsHash);

        // 1. Check Short-Term/In-Memory Cache (0 tokens)
        const cached = this.cache.get(cacheKey);
        if (cached) {
            console.error(`[CacheMiddleware] Found exact match in memory cache`);
            context.response = cached;
            return;
        }

        // 2. Proceed with LLM Pipeline execution
        await next();

        // 3. Post-execution: Save to cache
        if (context.response) {
            this.cache.set(cacheKey, context.response);
            await memoryManager.storeToolOutput('use_free_llm', {
                model: context.request.model || context.response.model,
                messages: context.request.messages,
                _ws: wsHash
            }, context.response);
        }
    }

    flush(): void {
        this.cache.flush();
        memoryManager.flush();
    }
}
