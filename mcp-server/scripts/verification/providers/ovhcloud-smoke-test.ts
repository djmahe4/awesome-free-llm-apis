/**
 * @file ovhcloud-smoke-test.ts
 * @description Verifies OVHcloud AI Endpoints models via ProviderRegistry.
 * Note: Free anonymous tier has a 2 RPM rate limit per model per IP.
 * Usage: tsx scripts/verification/providers/ovhcloud-smoke-test.ts
 */
import 'dotenv/config';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { OVHcloudProvider } from '../../../src/providers/ovhcloud.js';
import { CHANGED_MODELS } from './_changed-models.js';

async function testModel(provider: OVHcloudProvider, id: string) {
    console.error(`[>] Testing Model: ${id}`);
    try {
        const start = Date.now();
        const res = await provider.chat({
            model: id,
            messages: [{ role: 'user', content: 'Say "OK"' }],
            max_tokens: 16
        });
        const duration = Date.now() - start;
        const reply = res.choices?.[0]?.message?.content ?? (res.choices?.[0]?.message as any)?.reasoning ?? "";
        console.error(`    Status: SUCCESS / FREE (${duration}ms)`);
        console.error(`    Response: "${String(reply).trim().slice(0, 100)}"`);
        return { id, status: 'FREE' as const, duration };
    } catch (error: any) {
        const errMsg = error.message || '';
        if (errMsg.includes('429') || errMsg.includes('ratelimit')) {
            console.error(`    Status: RATE-LIMITED (${errMsg})`);
            return { id, status: 'RATE_LIMITED' as const, error: errMsg };
        }
        console.error(`    Status: FAILED (${errMsg})`);
        return { id, status: 'FAILED' as const, error: errMsg };
    } finally {
        console.error('');
    }
}

async function runOVHcloudSmokeTest() {
    const registry = ProviderRegistry.getInstance();
    const ovh = registry.getProvider('ovhcloud') as OVHcloudProvider;

    if (!ovh) {
        console.error('OVHcloud provider not found in registry.');
        process.exit(1);
    }

    if (!ovh.isAvailable()) {
        console.error('OVHcloud provider is not available.');
        process.exit(1);
    }

    // Test representative models covering Vision, Reasoning, Coding, and Fast Chat
    const testModels = [
        'Qwen3.5-397B-A17B',
        'gpt-oss-120b',
        'gpt-oss-20b',
        'Meta-Llama-3_3-70B-Instruct',
        'Mistral-Nemo-Instruct-2407',
    ];

    console.error(`\n=== OVHcloud AI Endpoints Live Smoke Test ===`);
    console.error(`Anonymous Free Tier (Keyless, 2 RPM per model)`);
    console.error(`Testing ${testModels.length} representative models...\n`);

    const results = [];
    for (const id of testModels) {
        results.push(await testModel(ovh, id));
        // Polite delay between distinct models
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`\n=== Results Summary: OVHcloud AI Endpoints ===`);
    results.forEach(r => console.log(`  [${r.status}] ${r.id}${r.status === 'FREE' ? ` (${r.duration}ms)` : ` — ${r.error}`}`));
}

runOVHcloudSmokeTest().catch(console.error);
