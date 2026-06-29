/**
 * @file zhipu-smoke-test.ts
 * @description Verifies all models defined in the Zhipu AI provider.
 * Usage: tsx scripts/verification/providers/zhipu-smoke-test.ts
 */
import 'dotenv/config';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { ZhipuProvider } from '../../../src/providers/zhipu.js';

async function runZhipuSmokeTest() {
    const registry = ProviderRegistry.getInstance();
    const zhipu = registry.getProvider('zhipu') as ZhipuProvider;

    if (!zhipu) {
        console.error('Zhipu provider not found in registry.');
        process.exit(1);
    }

    if (!zhipu.isAvailable()) {
        console.error('Zhipu provider is not available (check ZHIPU_API_KEY).');
        process.exit(1);
    }

    console.error(`\n=== Zhipu AI Model Smoke Test ===`);
    console.error(`Testing ${zhipu.models.length} models...\n`);

    for (const model of zhipu.models) {
        console.error(`[>] Testing Model: ${model.id} (${model.name})`);
        try {
            const start = Date.now();
            const res = await zhipu.chat({
                model: model.id,
                messages: [{ role: 'user', content: 'Say "OK"' }],
                max_tokens: 5
            });
            const duration = Date.now() - start;
            console.error(`    Status: SUCCESS (${duration}ms)`);
            console.error(`    Response: "${res.choices[0].message.content.trim()}"`);
        } catch (error: any) {
            console.error(`    Status: FAILED`);
            console.error(`    Error: ${error.message}`);
        }
        console.error('');
    }

    console.error(`=== Test Completed ===\n`);
}

runZhipuSmokeTest().catch(error => {
    console.error('Fatal error during Zhipu smoke test:', error);
    process.exit(1);
});
