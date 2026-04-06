import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { PipelineContext } from '../src/pipeline/middleware.js';

async function verifyHeaderExtraction() {
    const providerId = process.argv[2];
    if (!providerId) {
        console.error('Usage: npx tsx --env-file=.env scripts/verify-header-extraction.ts <providerId>');
        process.exit(1);
    }

    console.log(`=== Verifying Header Extraction for: ${providerId} ===\n`);

    const registry = ProviderRegistry.getInstance();
    const provider = registry.getProvider(providerId);

    if (!provider) {
        console.error(`Provider ${providerId} not found.`);
        process.exit(1);
    }

    if (!provider.isAvailable()) {
        console.error(`Provider ${providerId} is not available (check .env).`);
        process.exit(1);
    }

    const executor = new LLMExecutor();
    const modelId = provider.models[0].id;
    
    const context: PipelineContext = {
        request: {
            model: modelId,
            messages: [{ role: 'user', content: '.' }],
            max_tokens: 1
        },
        metadata: {}
    };

    console.log(`Making minimal request to ${providerId} (${modelId})...`);
    
    try {
        const response = await executor.tryProvider(context, providerId, modelId);
        
        if (!response) {
            console.error('Failed to get a response.');
            return;
        }

        console.log('\n--- Received Headers ---');
        const headers = response._headers || {};
        const ratelimitHeaders = Object.keys(headers)
            .filter(k => k.toLowerCase().includes('ratelimit'))
            .reduce((obj, key) => {
                obj[key] = headers[key];
                return obj;
            }, {} as Record<string, any>);

        if (Object.keys(ratelimitHeaders).length === 0) {
            console.log('No "ratelimit" specific headers found.');
            console.log('Full headers (truncated):', Object.keys(headers).slice(0, 5));
        } else {
            console.log(JSON.stringify(ratelimitHeaders, null, 2));
        }

        console.log('\n--- Parsed Token State ---');
        const state = executor.getTokenState()[providerId];
        console.log(JSON.stringify(state, null, 2));

        if (state && (state.remainingTokens !== undefined || state.remainingRequests !== undefined)) {
            console.log('\n✅ Extraction verified! Token tracking is working for this provider.');
        } else {
            console.log('\n⚠️ No token/request data was extracted. Verify standard rate limit headers for this provider.');
        }

    } catch (err: any) {
        console.error('\nError during verification:', err.status ? `HTTP ${err.status}: ${err.message}` : err.message);
    } finally {
        console.log('\n--- Final Parsed Token State ---');
        const state = executor.getTokenState()[providerId];
        console.log(JSON.stringify(state, null, 2));

        if (state && (state.remainingTokens === 0 || state.remainingRequests === 0)) {
            console.log('\n✅ Robustness verified! Rate limit detection updated the state.');
        } else if (state && (state.remainingTokens !== undefined)) {
             console.log('\n✅ Header extraction verified!');
        } else {
            console.log('\n⚠️ No token data available in state.');
        }
    }
}

verifyHeaderExtraction().catch(console.error);
