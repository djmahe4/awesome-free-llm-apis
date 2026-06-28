import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { ImageRouterMiddleware } from '../../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { getModelCapability } from '../../src/config/models.js';

async function runVisionSmokeTest() {
    console.log('\n=== Multi-Provider Vision Smoke Test ===');

    // Pick the image and convert to base64 upfront — done once, reused per provider
    const imagePath = 'C:\\Users\\mahes\\OneDrive\\Desktop\\Python-Projects\\footydj_mini_project\\docs\\assets\\activity_diagram.png';
    console.log(`[Test] Loading image: "${imagePath}"`);

    let base64DataUrl: string;
    try {
        const buffer = await fs.readFile(imagePath);
        const ext = path.extname(imagePath).toLowerCase().replace('.', '');
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        base64DataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
        console.log(`[Test] Image loaded and encoded (${(buffer.length / 1024).toFixed(1)} KB, mime: ${mimeType})\n`);
    } catch (err: any) {
        console.error(`[FATAL] Could not read image file: ${err.message}`);
        process.exit(1);
    }

    const prompt = 'Analyze this diagram and explain what it describes in a single short sentence.';

    // Detect available providers and match to vision-capable models
    const registry = ProviderRegistry.getInstance();
    const availableProviders = registry.getAvailableProviders();

    console.log(`[Test] Available providers: ${availableProviders.map(p => p.name).join(', ')}`);

    const providerModelPairs: Array<{ providerName: string; providerId: string; modelId: string }> = [];

    for (const provider of availableProviders) {
        if (['kilocode', 'siliconflow'].includes(provider.id)) {
            console.log(`[Skip] "${provider.name}" — excluded from vision smoke test`);
            continue;
        }
        if (provider.visionModels && provider.visionModels.length > 0) {
            // Score by imageModelCapabilities if available, else default 0.5
            const best = [...provider.visionModels].sort((a, b) =>
                (getModelCapability(b.id)) -
                (getModelCapability(a.id))
            )[0];
            providerModelPairs.push({ providerName: provider.name, providerId: provider.id, modelId: best.id });
        } else {
            console.log(`[Skip] "${provider.name}" — no visionModels declared`);
        }
    }

    if (providerModelPairs.length === 0) {
        console.error('[FATAL] No vision models found for any available provider.');
        process.exit(1);
    }

    console.log('\n[Test] Will test:');
    for (const p of providerModelPairs) {
        console.log(`  • ${p.providerName} (${p.providerId}) → "${p.modelId}"`);
    }

    // Results table
    const results: Array<{ provider: string; model: string; status: string; latencyMs?: number; response?: string; error?: string }> = [];

    for (const pair of providerModelPairs) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`[Testing] ${pair.providerName} → ${pair.modelId}`);
        console.log('─'.repeat(60));

        const provider = registry.getProvider(pair.providerId);
        if (!provider) {
            console.error(`[ERROR] Provider "${pair.providerId}" not found in registry.`);
            results.push({ provider: pair.providerName, model: pair.modelId, status: 'ERROR', error: 'Provider not in registry' });
            continue;
        }

        const start = Date.now();
        try {
            const res = await provider.chat({
                model: pair.modelId,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: base64DataUrl } }
                        ]
                    }
                ],
                max_tokens: 150,
                timeoutMs: 30000
            });

            const latencyMs = Date.now() - start;
            const content = res?.choices?.[0]?.message?.content || '';

            if (content) {
                console.log(`[✓ SUCCESS] ${latencyMs}ms`);
                console.log(`Response: ${content.trim()}`);
                results.push({ provider: pair.providerName, model: pair.modelId, status: '✓ PASS', latencyMs, response: content.trim() });
            } else {
                console.warn(`[⚠ EMPTY] ${latencyMs}ms — got response but content was empty`);
                console.log('Raw response:', JSON.stringify(res, null, 2));
                results.push({ provider: pair.providerName, model: pair.modelId, status: '⚠ EMPTY', latencyMs });
            }
        } catch (err: any) {
            const latencyMs = Date.now() - start;
            console.error(`[✗ FAILED] ${latencyMs}ms — ${err.message}`);
            results.push({ provider: pair.providerName, model: pair.modelId, status: '✗ FAIL', latencyMs, error: err.message });
        }
    }

    // Summary table
    console.log(`\n${'═'.repeat(60)}`);
    console.log('VISION SMOKE TEST SUMMARY');
    console.log('═'.repeat(60));
    console.log(`${'Provider'.padEnd(22)} ${'Model'.padEnd(38)} ${'Status'.padEnd(10)} ${'Latency'}`);
    console.log('─'.repeat(80));
    for (const r of results) {
        const latency = r.latencyMs !== undefined ? `${r.latencyMs}ms` : '-';
        console.log(`${r.provider.padEnd(22)} ${r.model.padEnd(38)} ${r.status.padEnd(10)} ${latency}`);
        if (r.error) console.log(`   Error: ${r.error}`);
    }
    console.log('═'.repeat(60));

    const passed = results.filter(r => r.status.startsWith('✓')).length;
    console.log(`\nResult: ${passed}/${results.length} providers passed vision test.\n`);
}

runVisionSmokeTest().catch(err => {
    console.error('Fatal error during vision smoke test:', err);
    process.exit(1);
});
