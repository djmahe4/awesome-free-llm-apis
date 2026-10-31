/**
 * @file gonka-smoke-test.ts
 * @description Verifies Gonka Broker models via the ProviderRegistry.
 * Usage: tsx scripts/verification/providers/gonka-smoke-test.ts
 */
import 'dotenv/config';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { GonkaProvider } from '../../../src/providers/gonka.js';
import { CHANGED_MODELS } from './_changed-models.js';

async function testModel(provider: GonkaProvider, id: string) {
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
        if (errMsg.includes('402') || errMsg.includes('credits') || errMsg.includes('subscription')) {
            console.error(`    Status: PAID / EXHAUSTED (${errMsg})`);
            return { id, status: 'PAID' as const, error: errMsg };
        }
        console.error(`    Status: FAILED (${errMsg})`);
        return { id, status: 'FAILED' as const, error: errMsg };
    } finally {
        console.error('');
    }
}

async function runGonkaSmokeTest() {
    const registry = ProviderRegistry.getInstance();
    const gonka = registry.getProvider('gonka') as GonkaProvider;

    if (!gonka) {
        console.error('Gonka Broker provider not found in registry.');
        process.exit(1);
    }

    if (!gonka.isAvailable()) {
        console.error('Gonka Broker provider is not available (check GONKA_API_KEY in .env).');
        process.exit(1);
    }

    const { added } = CHANGED_MODELS.gonka;

    console.error(`\n=== Gonka Broker Live Smoke Test ===`);
    console.error(`Models to test: ${added.length}\n`);

    const results = [];
    for (const id of added) {
        results.push(await testModel(gonka, id));
        // Free tier rate limit is 6 RPM (1 req every 10s)
        await new Promise(r => setTimeout(r, 11000));
    }

    console.log(`\n=== Results Summary: Gonka Broker ===`);
    results.forEach(r => console.log(`  [${r.status}] ${r.id}${r.status === 'FREE' ? ` (${r.duration}ms)` : ` — ${r.error}`}`));
}

runGonkaSmokeTest().catch(console.error);
